// Switch Site Upgrade, ported from switch-site-upgrade.py.
//
// MAKES CHANGES: it schedules, and can cancel, Junos firmware upgrades for the
// switches at the sites you tick. It draws its own screen (mount), because the
// choices depend on each other: the ticked sites decide which switch models
// are listed, and each model's version list comes from Mist. Nothing is sent
// until you press Preview, then Schedule, and confirm.
//
// Mist endpoints (checked against the Mist OpenAPI spec):
//   GET  /orgs/{org_id}/sites                                    (ctx.listSites)
//   GET  /sites/{site_id}/stats/devices?type=switch              switches, models, current versions
//   GET  /orgs/{org_id}/devices/versions?type=switch&model=A,B   versions Mist offers: [{model, version, tag}]
//   POST /orgs/{org_id}/devices/upgrade                          schedule -> {id, site_upgrades}
//   GET  /orgs/{org_id}/devices/upgrade                          the org's upgrades: [{id, site_upgrades}]
//   GET  /orgs/{org_id}/devices/upgrade/{id}                     status
//   POST /orgs/{org_id}/devices/upgrade/{id}/cancel              cancel
//
// Differences from the script, all forced by the browser:
//   * The curses menus become checklists, and each model's version is picked
//     from the list Mist offers (typed only when Mist lists none).
//   * The upgrade ID is not saved to last_upgrade_id.txt. It is shown, kept for
//     this tab, and Status / Cancel default to it, else to the newest upgrade.
//   * upgrade_status.xlsx keeps the script's columns: site_name, then every
//     other field in alphabetical order.
//
// Added here: the Upgrade log tab, every switch upgrade the org has (pending, in
// progress and finished) with its upgrade ID. Mist's list gives only IDs and site
// upgrade IDs, so each upgrade is read once (pooled) for its status and timing.
//
// The start-time rules, version order, status export and upgrade log are shared
// with AP Site Upgrade in ../lib/upgrade.js; this file keeps what is switch-only
// and every change it sends.

import {
  checkStart, compareVersions, defaultStart, flattenStatus, groupVersions, isFinished, loadDevices,
  loadUpgradeLog as loadLog, loadVersions as loadOrgVersions, localIso, logColumns, logRow, modelsFromDevices,
  readUpgrade, screenStatusColumns, sortLog, toLocalInput, upgradePhase, listUpgrades as listOrgUpgrades,
} from "../lib/upgrade.js";

export {
  checkStart, compareVersions, defaultStart, flattenStatus, groupVersions, isFinished, localIso, logRow,
  modelsFromDevices, readUpgrade, screenStatusColumns, sortLog, toLocalInput, upgradePhase,
};

const WARNING = "ONLY select EITHER QFX or EX models. Access and Core must not be done simultaneously. "
  + "Schedule at least 2 hrs apart. For sites with many access switches use the big_bang reboot strategy.";
export const LOG_COLUMNS = logColumns("Switches");

// ---- Pure helpers -------------------------------------------------------------------

/** True when the chosen models mix EX and QFX, which the script forbids in one upgrade. */
export function familyMix(models) {
  const fam = new Set(models.map((m) => (/^qfx/i.test(m) ? "QFX" : /^ex/i.test(m) ? "EX" : "other")));
  return fam.has("EX") && fam.has("QFX");
}

/** The switches the upgrade would touch, one row each, by site then name. */
export function planRows(switches, modelVersion) {
  return switches.filter((d) => modelVersion[d.model]).map((d) => ({
    site: d.__site, siteId: d.__siteId, name: d.name || "", mac: d.mac || "", model: d.model,
    current: d.version || "", target: modelVersion[d.model], state: d.status || "",
  })).sort((a, b) => a.site.localeCompare(b.site) || a.name.localeCompare(b.name));
}

/** The request body, exactly as the script built it. */
export function buildPayload({ siteIds, modelVersion, startDatetime, rebootStrategy }) {
  return {
    device_type: "switch",
    versions: [{ firmware_type: "junos", model_version: { ...modelVersion } }],
    all_sites: false,
    site_ids: [...siteIds],
    models: Object.keys(modelVersion),
    start_datetime: String(startDatetime).trim(),
    download_strategy: "big_bang",
    reboot_strategy: rebootStrategy === "big_bang" ? "big_bang" : "serial",
  };
}

// ---- Mist calls (take ctx) -------------------------------------------------------------

/** Switches at each site, fetched once per site. Returns { switches, failed }. */
export async function loadSwitches(ctx, sites, cache = new Map()) {
  const { devices, failed } = await loadDevices(ctx, sites, "switch", cache);
  return { switches: devices, failed };
}

/** The versions Mist offers for these switch models, in one call. {} when Mist offers none or errors. */
export const loadVersions = (ctx, models) => loadOrgVersions(ctx, "switch", models);

/** Recent switch upgrades in the org, newest first when Mist says when they were made. */
export const listUpgrades = (ctx) => listOrgUpgrades(ctx, "switch");

/** Every switch upgrade in the org, each read for its detail. Returns { rows, failed }. */
export const loadUpgradeLog = (ctx, siteNames = {}) => loadLog(ctx, siteNames, "switch");

const cannot = (ctx) => new Error(`Your token cannot make changes in this org (${ctx.access?.label || "permission unknown"}). `
  + "Nothing was sent.");

/** Send the upgrade. One POST, after the token check. Returns Mist's reply ({id, site_upgrades}). */
export async function scheduleUpgrade(ctx, payload) {
  if (!ctx.access?.canWrite) throw cannot(ctx);
  const res = await ctx.mistWrite("POST", `/orgs/${ctx.orgId}/devices/upgrade`, payload);
  ctx.log(res?.id ? `Upgrade scheduled. Upgrade ID: ${res.id}` : "Upgrade request sent; Mist returned no ID.", "ok");
  return res || {};
}

/** Cancel an upgrade: nothing is sent for one that already finished. Returns a sentence. */
export async function cancelUpgrade(ctx, id) {
  const data = await readUpgrade(ctx, id);
  if (isFinished(data)) {
    return `Upgrade ${id} is already ${data.status || "finished"}; nothing to cancel. Nothing was sent.`;
  }
  if (!ctx.access?.canWrite) throw cannot(ctx);
  await ctx.mistWrite("POST", `/orgs/${ctx.orgId}/devices/upgrade/${encodeURIComponent(id)}/cancel`);
  ctx.log(`Cancelled upgrade ${id}.`, "ok");
  return `Cancelled upgrade ${id}.`;
}

// ---- The tool -----------------------------------------------------------------------

export default {
  id: "switch-site-upgrade",
  name: "Switch Site Upgrade",
  description: "Schedules a Junos firmware upgrade for the switches at the sites you tick, with each "
    + "model's version picked from the list Mist offers; also shows an upgrade's status and cancels one. "
    + "Makes changes: preview first, then schedule and confirm.",
  tag: "Mist API",
  level: "Site · Org",
  needs: { mistToken: true, org: true },
  writes: true,

  async mount(ctx) {
    const E = ctx.esc;
    const root = ctx.mount;
    const $ = (sel) => root.querySelector(sel);
    const $$ = (sel) => [...root.querySelectorAll(sel)];
    const state = {
      sites: [], picked: new Set(), cache: new Map(), switches: [], models: [],
      versions: {}, versionsAsked: new Set(), choice: {}, previewKey: "", lastId: "", upgrades: [],
      log: null, logPhase: "",
    };

    root.innerHTML = `
<style>
  .ssu h2{font-size:1.02rem;margin:0 0 .5rem}
  .ssu .ssu-tabs{display:flex;gap:.4rem;flex-wrap:wrap}
  .ssu .ssu-sites{max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:10px;padding:.4rem .6rem;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:.1rem .8rem}
  .ssu label.ssu-check{display:flex;align-items:center;gap:.5rem;font-size:13px;min-height:28px;cursor:pointer}
  .ssu label.ssu-check input{width:auto;min-height:0;margin:0}
  .ssu .ssu-bar{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:.5rem}
  .ssu .ssu-bar input[type=search]{flex:1;min-width:180px}
  .ssu table.ssu-models{width:100%;border-collapse:collapse;font-size:13px}
  .ssu table.ssu-models th,.ssu table.ssu-models td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid var(--border);vertical-align:middle}
  .ssu table.ssu-models td input[type=checkbox]{width:auto;min-height:0}
  .ssu table.ssu-models select,.ssu table.ssu-models input[type=text]{min-height:36px;min-width:200px}
  .ssu .ssu-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:.85rem}
  .ssu,.ssu .stack>*,.ssu .ssu-row>*{min-width:0}
  .ssu .ssu-scroll{overflow-x:auto}
  .ssu button.ssu-id{background:none;border:0;padding:0;color:var(--accent);font:12px ui-monospace,"Cascadia Mono",Consolas,monospace;text-align:left;cursor:pointer;white-space:nowrap}
  .ssu button.ssu-id:hover{text-decoration:underline}
  .ssu .ssu-msg{font-size:13px}
  .ssu .ssu-note{font-size:12px;color:var(--subtle)}
</style>
<div class="ssu stack">
  <div class="ssu-tabs">
    <button class="chip on" type="button" data-tab="schedule">Schedule upgrade</button>
    <button class="chip" type="button" data-tab="log">Upgrade log</button>
    <button class="chip" type="button" data-tab="status">Upgrade status</button>
    <button class="chip" type="button" data-tab="cancel">Cancel upgrade</button>
  </div>

  <section class="stack" data-pane="schedule">
    <div class="card">
      <h2>1. Sites</h2>
      <div class="ssu-bar">
        <input type="search" id="ssuFilter" placeholder="Filter sites…" aria-label="Filter sites"/>
        <button class="btn btn-s" type="button" id="ssuAll">Select all</button>
        <button class="btn btn-g" type="button" id="ssuNone">Select none</button>
        <span class="muted ssu-msg" id="ssuCount">Loading sites…</span>
      </div>
      <div class="ssu-sites" id="ssuSites"></div>
    </div>
    <div class="card">
      <h2>2. Switch models and target versions</h2>
      <p class="warn ssu-msg" style="margin:0 0 .6rem">${E(WARNING)}</p>
      <div id="ssuModels" class="muted ssu-msg">Tick one or more sites to list their switch models.</div>
    </div>
    <div class="card">
      <h2>3. When and how</h2>
      <div class="ssu-row">
        <label><span>Start (your local time)</span>
          <input type="datetime-local" id="ssuStart"/>
          <div class="ssu-note" id="ssuTz"></div></label>
        <label><span>Reboot strategy</span>
          <select id="ssuReboot">
            <option value="serial">serial: one switch at a time (default)</option>
            <option value="big_bang">big_bang: all at once (sites with many access switches)</option>
          </select></label>
      </div>
    </div>
    <div class="card stack">
      <div class="actions">
        <button class="btn btn-s" type="button" id="ssuPreview">Preview (dry run)</button>
        <button class="btn btn-p" type="button" id="ssuSchedule" disabled>Schedule upgrade</button>
        <span class="ssu-msg muted" id="ssuState">Preview first. Nothing is sent until you schedule and confirm.</span>
      </div>
      <div id="ssuProblems"></div>
      <div id="ssuPlan"></div>
    </div>
  </section>

  <section class="stack hidden" data-pane="log">
    <div class="card stack">
      <h2>Upgrade log</h2>
      <p class="ssu-note" style="margin:0">Every switch upgrade Mist lists for this org: pending, in progress and finished,
        newest start first. Select an upgrade ID to see its status.</p>
      <div class="ssu-bar" style="margin:0">
        <button class="chip on" type="button" data-phase="">All</button>
        <button class="chip" type="button" data-phase="Pending">Pending</button>
        <button class="chip" type="button" data-phase="In progress">In progress</button>
        <button class="chip" type="button" data-phase="Finished">Finished</button>
      </div>
      <div class="actions">
        <button class="btn btn-s" type="button" id="ssuLogRefresh">Refresh</button>
        <button class="btn btn-s" type="button" id="ssuLogXlsx" disabled>Download log (.xlsx)</button>
        <span class="ssu-msg muted" id="ssuLogMsg"></span>
      </div>
      <div id="ssuLogOut"></div>
    </div>
  </section>

  <section class="stack hidden" data-pane="status">
    <div class="card stack">
      <h2>Upgrade status</h2>
      <div class="ssu-row">
        <label><span>Recent switch upgrades</span><select id="ssuStatusPick"></select></label>
        <label><span>…or an upgrade ID</span><input type="text" id="ssuStatusId" placeholder="upgrade ID" spellcheck="false"/></label>
      </div>
      <div class="actions"><button class="btn btn-p" type="button" id="ssuStatusGo">Show status</button>
        <span class="ssu-msg muted" id="ssuStatusMsg"></span></div>
      <div id="ssuStatusOut"></div>
    </div>
  </section>

  <section class="stack hidden" data-pane="cancel">
    <div class="card stack">
      <h2>Cancel an upgrade</h2>
      <div class="ssu-row">
        <label><span>Recent switch upgrades</span><select id="ssuCancelPick"></select></label>
        <label><span>…or an upgrade ID</span><input type="text" id="ssuCancelId" placeholder="upgrade ID" spellcheck="false"/></label>
      </div>
      <div class="actions"><button class="btn btn-p" type="button" id="ssuCancelGo">Cancel upgrade</button>
        <span class="ssu-msg muted" id="ssuCancelMsg"></span></div>
    </div>
  </section>
</div>`;

    // ---- small UI helpers
    const setMsg = (id, text, kind = "muted") => { const el = $(id); el.textContent = text || ""; el.className = `ssu-msg ${kind}`; };
    const confirmChange = (what) => window.confirm(`${what}\n\nSwitch Site Upgrade will make changes to ${ctx.orgName}.`
      + `\nYour token: ${ctx.access?.label || "permission unknown"}.\n\nContinue?`);
    const stale = () => {
      state.previewKey = "";
      $("#ssuSchedule").disabled = true;
      setMsg("#ssuState", "Preview first. Nothing is sent until you schedule and confirm.");
    };
    const downloadXlsx = async (prefix, sheets) => {
      const blob = await ctx.xlsx.workbook(sheets);
      ctx.download(blob, ctx.stampedName(prefix, ctx.orgName, "xlsx"));
    };

    // ---- tabs
    $$("[data-tab]").forEach((b) => { b.onclick = () => {
      $$("[data-tab]").forEach((x) => x.classList.toggle("on", x === b));
      $$("[data-pane]").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== b.dataset.tab));
      if (b.dataset.tab === "log") loadLog();
      else if (b.dataset.tab !== "schedule") refreshUpgrades();
    }; });

    // ---- 1. sites
    const renderSites = () => {
      const q = $("#ssuFilter").value.trim().toLowerCase();
      $("#ssuSites").innerHTML = state.sites.filter((s) => !q || s.name.toLowerCase().includes(q)).map((s) =>
        `<label class="ssu-check"><input type="checkbox" data-site="${E(s.id)}"${state.picked.has(s.id) ? " checked" : ""}/>${E(s.name)}</label>`).join("")
        || '<span class="muted ssu-msg">No site matches.</span>';
      setMsg("#ssuCount", `${state.picked.size} of ${state.sites.length} site(s) selected`);
    };
    let timer = 0;
    const sitesChanged = () => { renderSites(); stale(); clearTimeout(timer); timer = setTimeout(loadModels, 350); };
    $("#ssuSites").addEventListener("change", (e) => {
      const id = e.target?.dataset?.site;
      if (!id) return;
      if (e.target.checked) state.picked.add(id); else state.picked.delete(id);
      sitesChanged();
    });
    $("#ssuFilter").addEventListener("input", renderSites);
    const visibleIds = () => $$("[data-site]").map((i) => i.dataset.site);
    $("#ssuAll").onclick = () => { visibleIds().forEach((id) => state.picked.add(id)); sitesChanged(); };
    $("#ssuNone").onclick = () => { visibleIds().forEach((id) => state.picked.delete(id)); sitesChanged(); };

    // ---- 2. models and versions
    async function loadModels() {
      const sites = state.sites.filter((s) => state.picked.has(s.id));
      if (!sites.length) {
        state.switches = []; state.models = [];
        $("#ssuModels").innerHTML = '<span class="muted">Tick one or more sites to list their switch models.</span>';
        return;
      }
      $("#ssuModels").innerHTML = '<span class="muted">Reading the switches at the ticked sites…</span>';
      const { switches, failed } = await loadSwitches(ctx, sites, state.cache);
      state.switches = switches;
      state.models = modelsFromDevices(switches);
      const ask = state.models.map((m) => m.model).filter((m) => !state.versionsAsked.has(m));
      if (ask.length) {
        ask.forEach((m) => state.versionsAsked.add(m));
        Object.assign(state.versions, await loadVersions(ctx, ask));
      }
      renderModels(failed);
    }

    function renderModels(failed = []) {
      if (!state.models.length) {
        $("#ssuModels").innerHTML = '<span class="muted">No switches at the ticked sites.</span>';
        return;
      }
      const row = (m) => {
        const c = state.choice[m.model] || { on: false, version: "" };
        const offered = state.versions[m.model] || [];
        const current = Object.entries(m.versions).sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ×${n}`).join(", ");
        const onlyCurrent = Object.keys(m.versions).length === 1 ? Object.keys(m.versions)[0] : "";
        const pick = offered.length
          ? `<select data-ver="${E(m.model)}"${c.on ? "" : " disabled"}>
              <option value="">Choose a version…</option>
              ${offered.map((v) => `<option value="${E(v.version)}"${v.version === c.version ? " selected" : ""}>${E(v.version)}${v.tag ? ` · ${E(v.tag)}` : ""}${v.version === onlyCurrent ? " (current)" : ""}</option>`).join("")}
             </select>`
          : `<input type="text" data-ver="${E(m.model)}" value="${E(c.version)}" placeholder="e.g. 23.4R2-S3"${c.on ? "" : " disabled"}/>
             <div class="ssu-note">Mist listed no versions for this model; type one.</div>`;
        return `<tr><td><input type="checkbox" data-model="${E(m.model)}"${c.on ? " checked" : ""} aria-label="Upgrade ${E(m.model)}"/></td>
          <td><strong>${E(m.model)}</strong></td><td>${m.count}</td><td>${E(current)}</td>
          <td>${E(m.sites.join(", "))}</td><td>${pick}</td></tr>`;
      };
      $("#ssuModels").innerHTML = `
        <div class="ssu-scroll"><table class="ssu-models"><thead><tr><th>Upgrade</th><th>Model</th><th>Switches</th><th>Current versions</th><th>Sites</th><th>Target version</th></tr></thead>
        <tbody>${state.models.map(row).join("")}</tbody></table></div>
        ${failed.length ? `<p class="crit ssu-msg">Could not read: ${E(failed.map((f) => `${f.site} (${f.error})`).join("; "))}</p>` : ""}
        <p class="crit ssu-msg hidden" id="ssuMix">EX and QFX models are both ticked. Upgrade access and core separately, at least 2 hours apart.</p>`;
      showMix();
    }
    const chosenModels = () => state.models.map((m) => m.model).filter((m) => state.choice[m]?.on);
    const showMix = () => $("#ssuMix")?.classList.toggle("hidden", !familyMix(chosenModels()));
    $("#ssuModels").addEventListener("change", (e) => {
      const t = e.target;
      if (t.dataset.model) {
        const c = state.choice[t.dataset.model] || { on: false, version: "" };
        c.on = t.checked;
        state.choice[t.dataset.model] = c;
        const ver = root.querySelector(`[data-ver="${CSS.escape(t.dataset.model)}"]`);
        if (ver) ver.disabled = !c.on;
        showMix();
      } else if (t.dataset.ver) {
        const c = state.choice[t.dataset.ver] || { on: true, version: "" };
        c.version = t.value.trim();
        state.choice[t.dataset.ver] = c;
      }
      stale();
    });
    $("#ssuModels").addEventListener("input", (e) => {
      if (e.target.dataset.ver && e.target.tagName === "INPUT") {
        (state.choice[e.target.dataset.ver] ||= { on: true, version: "" }).version = e.target.value.trim();
        stale();
      }
    });

    // ---- 3. start time
    const start = $("#ssuStart");
    start.value = toLocalInput(defaultStart());
    const startIso = () => (start.value ? localIso(start.value, -new Date(start.value).getTimezoneOffset()) : "");
    const showTz = () => {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
      $("#ssuTz").textContent = start.value ? `Sent as ${startIso()} (${tz}).` : "";
    };
    showTz();
    start.addEventListener("input", () => { showTz(); stale(); });
    $("#ssuReboot").addEventListener("change", stale);

    // ---- preview and schedule
    const current = () => {
      const problems = [];
      const picked = state.sites.filter((s) => state.picked.has(s.id));
      if (!picked.length) problems.push("Tick at least one site.");
      const models = chosenModels();
      if (picked.length && !models.length) problems.push("Tick at least one switch model to upgrade.");
      const modelVersion = {};
      for (const m of models) {
        if (state.choice[m].version) modelVersion[m] = state.choice[m].version;
        else problems.push(`Choose a target version for ${m}.`);
      }
      if (familyMix(models)) problems.push("ONLY select EITHER QFX or EX models: access and core must not be upgraded together.");
      const iso = startIso();
      const startProblem = checkStart(iso);
      if (startProblem) problems.push(startProblem);
      const rows = planRows(state.switches, modelVersion);
      const siteIds = [...new Set(rows.map((r) => r.siteId))];
      const payload = buildPayload({ siteIds, modelVersion, startDatetime: iso, rebootStrategy: $("#ssuReboot").value });
      return { problems, rows, payload };
    };
    const planCols = [
      { header: "Site", key: "site", width: 28 }, { header: "Switch", key: "name", width: 24 },
      { header: "MAC", key: "mac", width: 18 }, { header: "Model", key: "model", width: 16 },
      { header: "Current Version", key: "current", width: 18 }, { header: "Target Version", key: "target", width: 18 },
      { header: "State", key: "state", width: 14 },
    ];
    const planSheets = (p, result) => {
      const info = [
        ["Org", ctx.orgName],
        ["Result", result || "Preview only: nothing sent"],
        ["Sites", p.payload.site_ids.length], ["Switches", p.rows.length],
        ["Start", p.payload.start_datetime], ["Download strategy", p.payload.download_strategy],
        ["Reboot strategy", p.payload.reboot_strategy], ["Reminder", WARNING],
        ["Request", `POST /orgs/${ctx.orgId}/devices/upgrade`], ["Body", JSON.stringify(p.payload, null, 2)],
        ["Generated", ctx.epochToUtc(Date.now())],
      ];
      return [
        ctx.xlsx.sheet("Upgrade Plan", planCols, p.rows.map((r) => ({ ...r, mac: r.mac ? ctx.fmtMac(String(r.mac)) : "" }))),
        ctx.xlsx.sheet("Request", [{ header: "Field", width: 24 }, { header: "Value", width: 90, wrap: true }], info,
          { autofilter: false, freeze: null }),
      ];
    };

    $("#ssuPreview").onclick = () => {
      const p = current();
      $("#ssuProblems").innerHTML = p.problems.length
        ? `<ul class="checklist crit">${p.problems.map((x) => `<li>${E(x)}</li>`).join("")}</ul>` : "";
      if (p.problems.length) { stale(); $("#ssuPlan").innerHTML = ""; return; }
      state.previewKey = JSON.stringify(p.payload);
      $("#ssuSchedule").disabled = false;
      setMsg("#ssuState", `Dry run: ${p.rows.length} switch(es) at ${p.payload.site_ids.length} site(s) would be upgraded. Nothing was sent.`);
      ctx.log(`Preview: ${p.rows.length} switch(es), ${p.payload.models.join(", ")}`, "info");
      $("#ssuPlan").innerHTML = `${ctx.previewTable(planCols, p.rows.map((r) => ({ ...r, mac: r.mac ? ctx.fmtMac(String(r.mac)) : "" })))}
        <p class="ssu-note" style="margin:.8rem 0 .3rem">Request that Schedule will send: POST /orgs/${E(ctx.orgId)}/devices/upgrade</p>
        <pre id="ssuJson">${E(JSON.stringify(p.payload, null, 2))}</pre>
        <div class="actions"><button class="btn btn-s" type="button" id="ssuPlanXlsx">Download plan (.xlsx)</button></div>`;
      $("#ssuPlanXlsx").onclick = () => downloadXlsx("mist_switch_upgrade_plan", planSheets(p));
    };

    $("#ssuSchedule").onclick = async () => {
      const p = current();
      if (p.problems.length || JSON.stringify(p.payload) !== state.previewKey) { stale(); return; }
      if (!confirmChange(`Schedule a firmware upgrade of ${p.rows.length} switch(es) at ${p.payload.site_ids.length} site(s), starting ${p.payload.start_datetime}?`)) {
        setMsg("#ssuState", "Not scheduled. Nothing was sent.");
        return;
      }
      $("#ssuSchedule").disabled = true;
      try {
        const res = await scheduleUpgrade(ctx, p.payload);
        state.lastId = res.id || "";
        state.previewKey = "";
        state.log = null;
        setMsg("#ssuState", res.id ? `Upgrade scheduled. Upgrade ID: ${res.id}` : "Upgrade request sent; Mist returned no ID.", "good");
        $("#ssuPlan").insertAdjacentHTML("afterbegin",
          `<p class="good ssu-msg"><strong>Scheduled.</strong> Upgrade ID <span class="mono" id="ssuNewId">${E(res.id || "")}</span>${
            (res.site_upgrades || []).length ? ` · ${res.site_upgrades.length} site upgrade(s)` : ""}. Use the Status tab to follow it.</p>
           <div class="actions"><button class="btn btn-s" type="button" id="ssuRecXlsx">Download record (.xlsx)</button></div>`);
        $("#ssuRecXlsx").onclick = () => downloadXlsx("mist_switch_upgrade_scheduled",
          planSheets(p, `Scheduled, upgrade ID ${res.id || "(none returned)"}`));
      } catch (e) {
        setMsg("#ssuState", e.message, "crit");
        ctx.log(e.message, "err");
        $("#ssuSchedule").disabled = false;
      }
    };

    // ---- status and cancel
    // The log is read once per visit and shared by the log and both pickers; Refresh,
    // Schedule and Cancel throw it away so the next look reads Mist again.
    async function ensureLog(force = false) {
      if (state.log && !force) return state.log;
      const names = Object.fromEntries(state.sites.map((s) => [s.id, s.name]));
      state.log = await loadUpgradeLog(ctx, names);
      return state.log;
    }
    async function refreshUpgrades() {
      try {
        state.upgrades = (await ensureLog()).rows;
      } catch (e) {
        state.upgrades = [];
        ctx.log(`Could not list upgrades (${e.message}); type an upgrade ID.`, "info");
      }
      const opts = state.upgrades.map((u) => {
        const st = u.status && u.phase !== "Unknown" ? ` · ${u.status}` : "";
        const when = u.startMs ? ` · ${ctx.fmtTime(u.startMs)}` : "";
        return `<option value="${E(u.upgrade_id)}">${E(u.upgrade_id)}${E(st)}${E(when)}</option>`;
      }).join("") || '<option value="">No switch upgrades listed</option>';
      for (const sel of ["#ssuStatusPick", "#ssuCancelPick"]) {
        $(sel).innerHTML = opts;
        if (state.lastId && state.upgrades.some((u) => u.upgrade_id === state.lastId)) $(sel).value = state.lastId;
      }
      if (state.lastId && !state.upgrades.some((u) => u.upgrade_id === state.lastId)) {
        $("#ssuStatusId").value ||= state.lastId;
        $("#ssuCancelId").value ||= state.lastId;
      }
    }
    const chosenId = (pick, typed) => $(typed).value.trim() || $(pick).value;

    const renderLog = () => {
      const all = state.log?.rows || [];
      const rows = all.filter((r) => !state.logPhase || r.phase === state.logPhase);
      const n = (ph) => all.filter((r) => r.phase === ph).length;
      setMsg("#ssuLogMsg", `${all.length} switch upgrade(s): ${n("Pending")} pending, ${n("In progress")} in progress, `
        + `${n("Finished")} finished${n("Unknown") ? `, ${n("Unknown")} unknown` : ""}.`
        + (state.log?.failed ? ` ${state.log.failed} could not be read.` : ""), state.log?.failed ? "warn" : "muted");
      const tone = (r) => (r.phase === "Pending" ? "accent" : r.phase === "In progress" ? "warn"
        : /fail|error/i.test(r.status) || r.failed ? "crit" : r.phase === "Finished" ? "good" : "subtle");
      const cell = (v) => `<td>${E(v === null || v === undefined || v === "" ? "—" : v)}</td>`;
      $("#ssuLogOut").innerHTML = rows.length ? `<div class="res-scroll"><table class="ap-table"><thead><tr>
          <th>Upgrade ID</th><th>Status</th><th>Start</th><th>Sites</th><th>Switches</th><th>Upgraded</th><th>Failed</th>
          <th>Versions</th><th>Reboot strategy</th></tr></thead><tbody>${rows.map((r) => `<tr>
          <td><button class="ssu-id" type="button" data-log-id="${E(r.upgrade_id)}" title="Show status">${E(r.upgrade_id)}</button></td>
          <td class="${tone(r)}">${E(r.phase)}${r.status && r.status.toLowerCase() !== r.phase.toLowerCase() ? ` · ${E(r.status)}` : ""}</td>
          ${cell(r.startMs ? ctx.fmtTime(r.startMs) : r.start)}
          <td title="${E(r.site_names)}">${E(r.site_count)}${r.site_names ? ` · ${E(r.site_names.length > 60 ? `${r.site_names.slice(0, 57)}…` : r.site_names)}` : ""}</td>
          ${cell(r.devices)}${cell(r.upgraded)}${cell(r.failed)}${cell(r.versions)}${cell(r.reboot_strategy)}</tr>`).join("")}
        </tbody></table></div>`
        : `<p class="muted ssu-msg">${all.length ? "No upgrade in this group." : "Mist lists no switch upgrades for this org."}</p>`;
      $$("[data-log-id]").forEach((b) => { b.onclick = () => {
        $("#ssuStatusId").value = b.dataset.logId;
        root.querySelector('[data-tab="status"]').click();
        $("#ssuStatusGo").click();
      }; });
    };

    async function loadLog(force = false) {
      $("#ssuLogRefresh").disabled = true;
      setMsg("#ssuLogMsg", "Reading the org's upgrades…");
      try {
        await ensureLog(force);
        $("#ssuLogXlsx").disabled = false;
        renderLog();
      } catch (e) {
        setMsg("#ssuLogMsg", `Could not list upgrades: ${e.message}`, "crit");
      } finally {
        $("#ssuLogRefresh").disabled = false;
      }
    }

    $$("[data-phase]").forEach((b) => { b.onclick = () => {
      $$("[data-phase]").forEach((x) => x.classList.toggle("on", x === b));
      state.logPhase = b.dataset.phase;
      renderLog();
    }; });
    $("#ssuLogRefresh").onclick = () => loadLog(true);
    $("#ssuLogXlsx").onclick = () => {
      const rows = state.log?.rows || [];
      downloadXlsx("mist_switch_upgrade_log", [
        ctx.xlsx.sheet("Upgrade Log", LOG_COLUMNS, rows),
        ctx.xlsx.sheet("Info", [{ header: "Field" }, { header: "Value", wrap: true }], [
          ["Org", ctx.orgName], ["Upgrades", rows.length],
          ["Source", `GET /orgs/${ctx.orgId}/devices/upgrade, then each upgrade by ID`],
          ["Generated", ctx.epochToUtc(Date.now())],
        ], { autofilter: false, freeze: null }),
      ]);
    };

    $("#ssuStatusGo").onclick = async () => {
      const id = chosenId("#ssuStatusPick", "#ssuStatusId");
      if (!id) { setMsg("#ssuStatusMsg", "Choose or type an upgrade ID.", "crit"); return; }
      setMsg("#ssuStatusMsg", "Reading…");
      try {
        const data = await readUpgrade(ctx, id);
        const names = Object.fromEntries(state.sites.map((s) => [s.id, s.name]));
        const { columns, rows } = flattenStatus(data, names);
        setMsg("#ssuStatusMsg", `Upgrade ${id}${data.status ? ` (${data.status})` : ""}: ${rows.length} device(s).`);
        const when = [["Start", data.start_datetime], ["Reboot", data.reboot_datetime],
          ["Download", data.download_strategy], ["Reboot strategy", data.reboot_strategy]]
          .map(([k, v]) => `${k}: ${v ?? "N/A"}`).join(" · ");
        $("#ssuStatusOut").innerHTML = `<p class="ssu-note" style="margin:0 0 .5rem">${E(when)}</p>
          ${ctx.previewTable(screenStatusColumns(columns), rows)}
          <div class="actions" style="margin-top:.6rem"><button class="btn btn-s" type="button" id="ssuStatusXlsx">Download status (.xlsx)</button></div>`;
        $("#ssuStatusXlsx").onclick = () => downloadXlsx("mist_upgrade_status", [
          ctx.xlsx.sheet("Upgrade Status", columns, rows),
          ctx.xlsx.sheet("Info", [{ header: "Field" }, { header: "Value", wrap: true }], [
            ["Org", ctx.orgName], ["Upgrade ID", id], ["Status", data.status ?? ""],
            ["Start", data.start_datetime ?? "N/A"], ["Reboot", data.reboot_datetime ?? "N/A"],
            ["Download strategy", data.download_strategy ?? "N/A"], ["Reboot strategy", data.reboot_strategy ?? "N/A"],
            ["Generated", ctx.epochToUtc(Date.now())],
          ], { autofilter: false, freeze: null }),
        ]);
      } catch (e) {
        setMsg("#ssuStatusMsg", e.message, "crit");
      }
    };

    $("#ssuCancelGo").onclick = async () => {
      const id = chosenId("#ssuCancelPick", "#ssuCancelId");
      if (!id) { setMsg("#ssuCancelMsg", "Choose or type an upgrade ID.", "crit"); return; }
      try {
        const data = await readUpgrade(ctx, id);
        if (isFinished(data)) {
          setMsg("#ssuCancelMsg", `Upgrade ${id} is already ${data.status || "finished"}; nothing to cancel. Nothing was sent.`);
          return;
        }
        if (!confirmChange(`Cancel upgrade ${id}${data.status ? ` (${data.status})` : ""}, covering ${(data.upgrades || []).length} site(s)?`)) {
          setMsg("#ssuCancelMsg", "Not cancelled. Nothing was sent.");
          return;
        }
        setMsg("#ssuCancelMsg", await cancelUpgrade(ctx, id), "good");
        state.log = null;
      } catch (e) {
        setMsg("#ssuCancelMsg", e.message, "crit");
      }
    };

    // ---- start: the org's sites
    try {
      state.sites = (await ctx.listSites()).map((s) => ({ id: s.id, name: s.name || s.id }));
      renderSites();
    } catch (e) {
      setMsg("#ssuCount", `Could not list sites: ${e.message}`, "crit");
    }
  },

  // mount() owns the view; run() exists so the tool shape stays uniform.
  async run() {
    return { rendered: true };
  },
};
