// AP Site Upgrade, modelled on Switch Site Upgrade (there is no original script).
//
// MAKES CHANGES: it schedules, and can cancel, firmware upgrades for the access
// points at the sites you tick. It draws its own screen (mount): the ticked sites
// decide which AP models are listed, and the version list comes from Mist. Nothing
// is sent until you press Preview, then Schedule, and confirm.
//
// Mist endpoints (checked against the Mist OpenAPI spec, 2509.1.1):
//   GET  /orgs/{org_id}/sites                                 (ctx.listSites)
//   GET  /sites/{site_id}/stats/devices?type=ap               APs, models, current versions
//   GET  /orgs/{org_id}/devices/versions?type=ap&model=A,B    versions Mist offers: [{model, version, tag}]
//   POST /orgs/{org_id}/devices/upgrade                       schedule -> {id, site_upgrades}
//                                                             (the spec: "Only supported for Access Points upgrades")
//   GET  /orgs/{org_id}/devices/upgrade                       the org's upgrades: [{id, site_upgrades}]
//   GET  /orgs/{org_id}/devices/upgrade/{id}                  status
//   POST /orgs/{org_id}/devices/upgrade/{id}/cancel           cancel
//
// How it differs from the switch upgrade, per the spec:
//   * One version for every chosen model: versions[].model_version is Junos-only,
//     so an AP upgrade carries versions: [{firmware_type: "ap", version, force}].
//     The drop-down offers the versions Mist lists for every chosen model.
//   * Without force, Mist skips an AP already at or above the target version.
//   * strategy is big_bang, serial, canary or rrm (radio-aware, APs only), with
//     max_failure_percentage, canary_phases and the rrm_* settings as they apply.
//     APs reboot on their own, so there is no reboot strategy.
//   * The start must be at least 15 minutes ahead (switches: 2 hours).
//
// Shared with Switch Site Upgrade in ../lib/upgrade.js: the start-time rules,
// version order, status export and the upgrade log.

import {
  byTagThenNewest, checkStart, compareVersions, defaultStart, flattenStatus, isFinished, loadDevices,
  loadUpgradeLog as loadLog, loadVersions as loadOrgVersions, localIso, logColumns, modelsFromDevices,
  readUpgrade, screenStatusColumns, toLocalInput,
} from "../lib/upgrade.js";

const WARNING = "APs reboot as they upgrade: clients on each AP lose Wi-Fi for a few minutes. big_bang reboots "
  + "every AP at once; for sites in use, prefer rrm (neighbouring APs in different batches) or canary.";
export const MIN_LEAD_MS = 15 * 60 * 1000;
const LOG_COLUMNS = logColumns("APs");
export const STRATEGIES = ["big_bang", "serial", "canary", "rrm"];
export const DEFAULT_OPTIONS = {
  maxFailurePct: 5, canaryPhases: "1, 10, 50, 100",
  rrmNodeOrder: "fringe_to_center", rrmMeshUpgrade: "sequential",
  rrmFirstBatchPct: "", rrmMaxBatchPct: "", rrmSlowRamp: false,
};

// ---- Pure helpers -------------------------------------------------------------------

/** AP models in use: [{ model, count, sites: [names], versions: {version: count} }], by model. */
export const modelsFromAps = (devices) => modelsFromDevices(devices, "ap");

/**
 * The versions Mist offers for every one of the chosen models, stable first, then
 * newest. [] when any chosen model has no list, so the screen asks for a typed one.
 */
export function commonVersions(versionsByModel, models) {
  if (!models.length) return [];
  const lists = models.map((m) => versionsByModel[m] || []);
  if (lists.some((l) => !l.length)) return [];
  return lists[0].filter((v) => lists.every((l) => l.some((x) => x.version === v.version))).sort(byTagThenNewest);
}

/** "1, 10, 50, 100" -> [1, 10, 50, 100]; null when it is not a list of whole numbers. */
export function parsePhases(text) {
  const parts = String(text || "").split(/[\s,]+/).filter(Boolean);
  if (!parts.length || parts.some((p) => !/^\d+$/.test(p))) return null;
  return parts.map(Number);
}

const pct = (v) => /^\d+$/.test(String(v).trim()) && Number(v) >= 0 && Number(v) <= 100;

/** The strategy's own settings, checked. Returns a list of problems. */
export function checkOptions(strategy, opts) {
  const problems = [];
  if (!STRATEGIES.includes(strategy)) problems.push(`Unknown strategy "${strategy}".`);
  if (strategy !== "big_bang" && !pct(opts.maxFailurePct)) problems.push("Max failures must be a whole percentage, 0 to 100.");
  if (strategy === "canary") {
    const phases = parsePhases(opts.canaryPhases);
    if (!phases || phases.some((p) => p < 1 || p > 100) || phases.some((p, i) => i && p <= phases[i - 1])
      || phases[phases.length - 1] !== 100) {
      problems.push("Canary phases must be rising percentages that end at 100, e.g. 1, 10, 50, 100.");
    }
  }
  if (strategy === "rrm") {
    const first = String(opts.rrmFirstBatchPct ?? "").trim();
    const max = String(opts.rrmMaxBatchPct ?? "").trim();
    if (first && (!pct(first) || Number(first) < 1)) problems.push("RRM first batch must be a percentage, 1 to 100.");
    if (max && (!pct(max) || Number(max) < 1)) problems.push("RRM max batch must be a percentage, 1 to 100.");
    if (first && max && pct(first) && pct(max) && Number(first) > Number(max)) {
      problems.push("RRM first batch cannot be larger than the max batch.");
    }
  }
  return problems;
}

/**
 * The APs the upgrade would touch, one row each, by site then name. Without force,
 * Mist skips an AP already at or above the target, and the row says so.
 */
export function planRows(aps, models, version, force = false) {
  const chosen = new Set(models);
  return aps.filter((d) => chosen.has(d.model)).map((d) => {
    const current = d.version || "";
    const skip = !force && current && compareVersions(current, version) >= 0;
    return {
      site: d.__site, siteId: d.__siteId, name: d.name || "", mac: d.mac || "", model: d.model,
      current, target: version, state: d.status || "",
      note: skip ? (current === version ? "Skipped: already on this version" : "Skipped: newer than the target") : "",
    };
  }).sort((a, b) => a.site.localeCompare(b.site) || a.name.localeCompare(b.name));
}

/** The request body: only the settings that apply to the chosen strategy. */
export function buildPayload({ siteIds, models, version, force = false, startDatetime, strategy, opts = DEFAULT_OPTIONS }) {
  const body = {
    device_type: "ap",
    versions: [{ firmware_type: "ap", version: String(version).trim(), force: Boolean(force) }],
    all_sites: false,
    site_ids: [...siteIds],
    models: [...models],
    start_datetime: String(startDatetime).trim(),
    strategy,
  };
  if (strategy !== "big_bang") body.max_failure_percentage = Number(opts.maxFailurePct);
  if (strategy === "canary") body.canary_phases = parsePhases(opts.canaryPhases);
  if (strategy === "rrm") {
    body.rrm_node_order = opts.rrmNodeOrder === "center_to_fringe" ? "center_to_fringe" : "fringe_to_center";
    body.rrm_mesh_upgrade = opts.rrmMeshUpgrade === "parallel" ? "parallel" : "sequential";
    if (String(opts.rrmFirstBatchPct ?? "").trim()) body.rrm_first_batch_percentage = Number(opts.rrmFirstBatchPct);
    if (String(opts.rrmMaxBatchPct ?? "").trim()) body.rrm_max_batch_percentage = Number(opts.rrmMaxBatchPct);
    body.rrm_slow_ramp = Boolean(opts.rrmSlowRamp);
  }
  return body;
}

// ---- Mist calls (take ctx) -------------------------------------------------------------

/** APs at each site, fetched once per site. Returns { aps, failed }. */
export async function loadAps(ctx, sites, cache = new Map()) {
  const { devices, failed } = await loadDevices(ctx, sites, "ap", cache);
  return { aps: devices, failed };
}

/** The versions Mist offers for these AP models, in one call. {} when Mist offers none or errors. */
export const loadVersions = (ctx, models) => loadOrgVersions(ctx, "ap", models);

/** Every AP upgrade in the org, each read for its detail. Returns { rows, failed }. */
export const loadUpgradeLog = (ctx, siteNames = {}) => loadLog(ctx, siteNames, "ap");

const cannot = (ctx) => new Error(`Your token cannot make changes in this org (${ctx.access?.label || "permission unknown"}). `
  + "Nothing was sent.");

/** Send the upgrade. One POST, after the token check. Returns Mist's reply ({id, site_upgrades}). */
export async function scheduleUpgrade(ctx, payload) {
  if (!ctx.access?.canWrite) throw cannot(ctx);
  const res = await ctx.mistWrite("POST", `/orgs/${ctx.orgId}/devices/upgrade`, payload);
  ctx.log(res?.id ? `AP upgrade scheduled. Upgrade ID: ${res.id}` : "Upgrade request sent; Mist returned no ID.", "ok");
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
  id: "ap-site-upgrade",
  name: "AP Site Upgrade",
  description: "Schedules a firmware upgrade for the access points at the sites you tick, with the version "
    + "picked from the list Mist offers and a big-bang, serial, canary or RRM rollout; also keeps a log of AP "
    + "upgrades, shows an upgrade's status and cancels one. Makes changes: preview first, then schedule and confirm.",
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
      sites: [], picked: new Set(), cache: new Map(), aps: [], models: [],
      versions: {}, versionsAsked: new Set(), chosen: new Set(), version: "", previewKey: "", lastId: "",
      upgrades: [], log: null, logPhase: "",
    };

    root.innerHTML = `
<style>
  .asu h2{font-size:1.02rem;margin:0 0 .5rem}
  .asu .asu-tabs{display:flex;gap:.4rem;flex-wrap:wrap}
  .asu .asu-sites{max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:10px;padding:.4rem .6rem;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:.1rem .8rem}
  .asu label.asu-check{display:flex;align-items:center;gap:.5rem;font-size:13px;min-height:28px;cursor:pointer}
  .asu label.asu-check input{width:auto;min-height:0;margin:0}
  .asu .asu-bar{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:.5rem}
  .asu .asu-bar input[type=search]{flex:1;min-width:180px}
  .asu table.asu-models{width:100%;border-collapse:collapse;font-size:13px}
  .asu table.asu-models th,.asu table.asu-models td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid var(--border);vertical-align:middle}
  .asu table.asu-models td input[type=checkbox]{width:auto;min-height:0}
  .asu .asu-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:.85rem}
  .asu,.asu .stack>*,.asu .asu-row>*{min-width:0}
  .asu .asu-scroll{overflow-x:auto}
  .asu button.asu-id{background:none;border:0;padding:0;color:var(--accent);font:12px ui-monospace,"Cascadia Mono",Consolas,monospace;text-align:left;cursor:pointer;white-space:nowrap}
  .asu button.asu-id:hover{text-decoration:underline}
  .asu .asu-msg{font-size:13px}
  .asu .asu-note{font-size:12px;color:var(--subtle)}
</style>
<div class="asu stack">
  <div class="asu-tabs">
    <button class="chip on" type="button" data-tab="schedule">Schedule upgrade</button>
    <button class="chip" type="button" data-tab="log">Upgrade log</button>
    <button class="chip" type="button" data-tab="status">Upgrade status</button>
    <button class="chip" type="button" data-tab="cancel">Cancel upgrade</button>
  </div>

  <section class="stack" data-pane="schedule">
    <div class="card">
      <h2>1. Sites</h2>
      <div class="asu-bar">
        <input type="search" id="asuFilter" placeholder="Filter sites…" aria-label="Filter sites"/>
        <button class="btn btn-s" type="button" id="asuAll">Select all</button>
        <button class="btn btn-g" type="button" id="asuNone">Select none</button>
        <span class="muted asu-msg" id="asuCount">Loading sites…</span>
      </div>
      <div class="asu-sites" id="asuSites"></div>
    </div>
    <div class="card">
      <h2>2. AP models and target version</h2>
      <p class="warn asu-msg" style="margin:0 0 .6rem">${E(WARNING)}</p>
      <div id="asuModels" class="muted asu-msg">Tick one or more sites to list their AP models.</div>
      <div class="asu-row" style="margin-top:.8rem">
        <label><span>Target version (for every ticked model)</span><span id="asuVersionBox"></span></label>
        <label class="asu-check" style="align-self:end"><input type="checkbox" id="asuForce"/>
          Force: upgrade even APs already on this version or newer</label>
      </div>
    </div>
    <div class="card">
      <h2>3. When and how</h2>
      <div class="asu-row">
        <label><span>Start (your local time, at least 15 minutes ahead)</span>
          <input type="datetime-local" id="asuStart"/>
          <div class="asu-note" id="asuTz"></div></label>
        <label><span>Strategy</span>
          <select id="asuStrategy">
            <option value="big_bang">big_bang: every AP at once (default)</option>
            <option value="serial">serial: one AP at a time</option>
            <option value="canary">canary: in phases, by percentage of APs</option>
            <option value="rrm">rrm: radio-aware batches, neighbours apart</option>
          </select></label>
        <label data-opt="paced"><span>Max failures (% of APs) before Mist stops</span>
          <input type="number" id="asuMaxFail" min="0" max="100" step="1"/></label>
        <label data-opt="canary"><span>Canary phases (% of APs, ending at 100)</span>
          <input type="text" id="asuPhases" spellcheck="false"/></label>
        <label data-opt="rrm"><span>RRM node order</span>
          <select id="asuNodeOrder">
            <option value="fringe_to_center">fringe_to_center (default)</option>
            <option value="center_to_fringe">center_to_fringe</option>
          </select></label>
        <label data-opt="rrm"><span>Mesh APs</span>
          <select id="asuMesh">
            <option value="sequential">sequential, at the end (default)</option>
            <option value="parallel">parallel, at the end</option>
          </select></label>
        <label data-opt="rrm"><span>First batch (% of APs, blank: Mist's default)</span>
          <input type="number" id="asuFirstBatch" min="1" max="100" step="1"/></label>
        <label data-opt="rrm"><span>Max batch (% of APs, blank: Mist's default)</span>
          <input type="number" id="asuMaxBatch" min="1" max="100" step="1"/></label>
        <label class="asu-check" data-opt="rrm" style="align-self:end"><input type="checkbox" id="asuSlowRamp"/>
          Slow ramp: batch sizes grow slowly</label>
      </div>
    </div>
    <div class="card stack">
      <div class="actions">
        <button class="btn btn-s" type="button" id="asuPreview">Preview (dry run)</button>
        <button class="btn btn-p" type="button" id="asuSchedule" disabled>Schedule upgrade</button>
        <span class="asu-msg muted" id="asuState">Preview first. Nothing is sent until you schedule and confirm.</span>
      </div>
      <div id="asuProblems"></div>
      <div id="asuPlan"></div>
    </div>
  </section>

  <section class="stack hidden" data-pane="log">
    <div class="card stack">
      <h2>Upgrade log</h2>
      <p class="asu-note" style="margin:0">Every AP upgrade Mist lists for this org: pending, in progress and finished,
        newest start first. An upgrade whose device type Mist does not say is listed too. Select an upgrade ID to see its status.</p>
      <div class="asu-bar" style="margin:0">
        <button class="chip on" type="button" data-phase="">All</button>
        <button class="chip" type="button" data-phase="Pending">Pending</button>
        <button class="chip" type="button" data-phase="In progress">In progress</button>
        <button class="chip" type="button" data-phase="Finished">Finished</button>
      </div>
      <div class="actions">
        <button class="btn btn-s" type="button" id="asuLogRefresh">Refresh</button>
        <button class="btn btn-s" type="button" id="asuLogXlsx" disabled>Download log (.xlsx)</button>
        <span class="asu-msg muted" id="asuLogMsg"></span>
      </div>
      <div id="asuLogOut"></div>
    </div>
  </section>

  <section class="stack hidden" data-pane="status">
    <div class="card stack">
      <h2>Upgrade status</h2>
      <div class="asu-row">
        <label><span>Recent AP upgrades</span><select id="asuStatusPick"></select></label>
        <label><span>…or an upgrade ID</span><input type="text" id="asuStatusId" placeholder="upgrade ID" spellcheck="false"/></label>
      </div>
      <div class="actions"><button class="btn btn-p" type="button" id="asuStatusGo">Show status</button>
        <span class="asu-msg muted" id="asuStatusMsg"></span></div>
      <div id="asuStatusOut"></div>
    </div>
  </section>

  <section class="stack hidden" data-pane="cancel">
    <div class="card stack">
      <h2>Cancel an upgrade</h2>
      <p class="asu-note" style="margin:0">Mist cancels on a best-effort basis: APs already upgraded stay upgraded.</p>
      <div class="asu-row">
        <label><span>Recent AP upgrades</span><select id="asuCancelPick"></select></label>
        <label><span>…or an upgrade ID</span><input type="text" id="asuCancelId" placeholder="upgrade ID" spellcheck="false"/></label>
      </div>
      <div class="actions"><button class="btn btn-p" type="button" id="asuCancelGo">Cancel upgrade</button>
        <span class="asu-msg muted" id="asuCancelMsg"></span></div>
    </div>
  </section>
</div>`;

    // ---- small UI helpers
    const setMsg = (id, text, kind = "muted") => { const el = $(id); el.textContent = text || ""; el.className = `asu-msg ${kind}`; };
    const confirmChange = (what) => window.confirm(`${what}\n\nAP Site Upgrade will make changes to ${ctx.orgName}.`
      + `\nYour token: ${ctx.access?.label || "permission unknown"}.\n\nContinue?`);
    const stale = () => {
      state.previewKey = "";
      $("#asuSchedule").disabled = true;
      setMsg("#asuState", "Preview first. Nothing is sent until you schedule and confirm.");
    };
    const downloadXlsx = async (prefix, sheets) => {
      const blob = await ctx.xlsx.workbook(sheets);
      ctx.download(blob, ctx.stampedName(prefix, ctx.orgName, "xlsx"));
    };
    const macName = () => Object.fromEntries(state.aps.filter((d) => d.mac).map((d) => [d.mac, d.name || ""]));

    // ---- tabs
    $$("[data-tab]").forEach((b) => { b.onclick = () => {
      $$("[data-tab]").forEach((x) => x.classList.toggle("on", x === b));
      $$("[data-pane]").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== b.dataset.tab));
      if (b.dataset.tab === "log") loadLogTab();
      else if (b.dataset.tab !== "schedule") refreshUpgrades();
    }; });

    // ---- 1. sites
    const renderSites = () => {
      const q = $("#asuFilter").value.trim().toLowerCase();
      $("#asuSites").innerHTML = state.sites.filter((s) => !q || s.name.toLowerCase().includes(q)).map((s) =>
        `<label class="asu-check"><input type="checkbox" data-site="${E(s.id)}"${state.picked.has(s.id) ? " checked" : ""}/>${E(s.name)}</label>`).join("")
        || '<span class="muted asu-msg">No site matches.</span>';
      setMsg("#asuCount", `${state.picked.size} of ${state.sites.length} site(s) selected`);
    };
    let timer = 0;
    const sitesChanged = () => { renderSites(); stale(); clearTimeout(timer); timer = setTimeout(loadModels, 350); };
    $("#asuSites").addEventListener("change", (e) => {
      const id = e.target?.dataset?.site;
      if (!id) return;
      if (e.target.checked) state.picked.add(id); else state.picked.delete(id);
      sitesChanged();
    });
    $("#asuFilter").addEventListener("input", renderSites);
    const visibleIds = () => $$("[data-site]").map((i) => i.dataset.site);
    $("#asuAll").onclick = () => { visibleIds().forEach((id) => state.picked.add(id)); sitesChanged(); };
    $("#asuNone").onclick = () => { visibleIds().forEach((id) => state.picked.delete(id)); sitesChanged(); };

    // ---- 2. models and the version
    async function loadModels() {
      const sites = state.sites.filter((s) => state.picked.has(s.id));
      if (!sites.length) {
        state.aps = []; state.models = [];
        $("#asuModels").innerHTML = '<span class="muted">Tick one or more sites to list their AP models.</span>';
        renderVersion();
        return;
      }
      $("#asuModels").innerHTML = '<span class="muted">Reading the APs at the ticked sites…</span>';
      const { aps, failed } = await loadAps(ctx, sites, state.cache);
      state.aps = aps;
      state.models = modelsFromAps(aps);
      const ask = state.models.map((m) => m.model).filter((m) => !state.versionsAsked.has(m));
      if (ask.length) {
        ask.forEach((m) => state.versionsAsked.add(m));
        Object.assign(state.versions, await loadVersions(ctx, ask));
      }
      renderModels(failed);
    }

    const chosenModels = () => state.models.map((m) => m.model).filter((m) => state.chosen.has(m));

    function renderModels(failed = []) {
      if (!state.models.length) {
        $("#asuModels").innerHTML = '<span class="muted">No APs at the ticked sites.</span>';
        renderVersion();
        return;
      }
      const row = (m) => {
        const current = Object.entries(m.versions).sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ×${n}`).join(", ");
        const offered = (state.versions[m.model] || []).length;
        return `<tr><td><input type="checkbox" data-model="${E(m.model)}"${state.chosen.has(m.model) ? " checked" : ""} aria-label="Upgrade ${E(m.model)}"/></td>
          <td><strong>${E(m.model)}</strong></td><td>${m.count}</td><td>${E(current)}</td>
          <td>${E(m.sites.join(", "))}</td><td>${offered || '<span class="muted">none listed</span>'}</td></tr>`;
      };
      $("#asuModels").innerHTML = `
        <div class="asu-scroll"><table class="asu-models"><thead><tr><th>Upgrade</th><th>Model</th><th>APs</th><th>Current versions</th><th>Sites</th><th>Versions offered</th></tr></thead>
        <tbody>${state.models.map(row).join("")}</tbody></table></div>
        ${failed.length ? `<p class="crit asu-msg">Could not read: ${E(failed.map((f) => `${f.site} (${f.error})`).join("; "))}</p>` : ""}`;
      renderVersion();
    }

    function renderVersion() {
      const models = chosenModels();
      const offered = commonVersions(state.versions, models);
      const box = $("#asuVersionBox");
      if (!models.length) {
        box.innerHTML = '<select disabled><option>Tick an AP model first</option></select>';
        return;
      }
      if (offered.length) {
        if (!offered.some((v) => v.version === state.version)) state.version = "";
        box.innerHTML = `<select id="asuVersion"><option value="">Choose a version…</option>
          ${offered.map((v) => `<option value="${E(v.version)}"${v.version === state.version ? " selected" : ""}>${E(v.version)}${v.tag ? ` · ${E(v.tag)}` : ""}</option>`).join("")}
          </select>`;
      } else {
        box.innerHTML = `<input type="text" id="asuVersion" value="${E(state.version)}" placeholder="e.g. 0.14.29633" spellcheck="false"/>
          <div class="asu-note">Mist listed no version common to every ticked model; type one.</div>`;
      }
    }

    $("#asuModels").addEventListener("change", (e) => {
      const m = e.target.dataset.model;
      if (!m) return;
      if (e.target.checked) state.chosen.add(m); else state.chosen.delete(m);
      renderVersion();
      stale();
    });
    const versionChanged = (e) => {
      if (e.target.id !== "asuVersion") return;
      state.version = e.target.value.trim();
      stale();
    };
    $("#asuVersionBox").addEventListener("change", versionChanged);
    $("#asuVersionBox").addEventListener("input", versionChanged);
    $("#asuForce").addEventListener("change", stale);

    // ---- 3. start time and strategy
    const start = $("#asuStart");
    start.value = toLocalInput(defaultStart(Date.now(), 60));
    const startIso = () => (start.value ? localIso(start.value, -new Date(start.value).getTimezoneOffset()) : "");
    const showTz = () => {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
      $("#asuTz").textContent = start.value ? `Sent as ${startIso()} (${tz}).` : "";
    };
    showTz();
    start.addEventListener("input", () => { showTz(); stale(); });

    $("#asuMaxFail").value = DEFAULT_OPTIONS.maxFailurePct;
    $("#asuPhases").value = DEFAULT_OPTIONS.canaryPhases;
    const showOptions = () => {
      const s = $("#asuStrategy").value;
      $$("[data-opt]").forEach((el) => el.classList.toggle("hidden",
        !(el.dataset.opt === s || (el.dataset.opt === "paced" && s !== "big_bang"))));
    };
    showOptions();
    $("#asuStrategy").addEventListener("change", () => { showOptions(); stale(); });
    ["#asuMaxFail", "#asuPhases", "#asuNodeOrder", "#asuMesh", "#asuFirstBatch", "#asuMaxBatch", "#asuSlowRamp"]
      .forEach((id) => { $(id).addEventListener("input", stale); $(id).addEventListener("change", stale); });
    const options = () => ({
      maxFailurePct: $("#asuMaxFail").value.trim(), canaryPhases: $("#asuPhases").value,
      rrmNodeOrder: $("#asuNodeOrder").value, rrmMeshUpgrade: $("#asuMesh").value,
      rrmFirstBatchPct: $("#asuFirstBatch").value.trim(), rrmMaxBatchPct: $("#asuMaxBatch").value.trim(),
      rrmSlowRamp: $("#asuSlowRamp").checked,
    });

    // ---- preview and schedule
    const current = () => {
      const problems = [];
      const picked = state.sites.filter((s) => state.picked.has(s.id));
      if (!picked.length) problems.push("Tick at least one site.");
      const models = chosenModels();
      if (picked.length && !models.length) problems.push("Tick at least one AP model to upgrade.");
      if (models.length && !state.version) problems.push("Choose a target version.");
      const strategy = $("#asuStrategy").value;
      const opts = options();
      problems.push(...checkOptions(strategy, opts));
      const iso = startIso();
      const startProblem = checkStart(iso, Date.now(), MIN_LEAD_MS);
      if (startProblem) problems.push(startProblem);
      const force = $("#asuForce").checked;
      const rows = planRows(state.aps, models, state.version, force);
      const siteIds = [...new Set(rows.map((r) => r.siteId))];
      if (models.length && state.version && !rows.length) problems.push("No AP at the ticked sites has a ticked model.");
      const payload = buildPayload({ siteIds, models, version: state.version, force, startDatetime: iso, strategy, opts });
      return { problems, rows, payload };
    };
    const planCols = [
      { header: "Site", key: "site", width: 28 }, { header: "AP", key: "name", width: 24 },
      { header: "MAC", key: "mac", width: 18 }, { header: "Model", key: "model", width: 12 },
      { header: "Current Version", key: "current", width: 18 }, { header: "Target Version", key: "target", width: 18 },
      { header: "State", key: "state", width: 14 }, { header: "Note", key: "note", width: 34 },
    ];
    const shown = (rows) => rows.map((r) => ({ ...r, mac: r.mac ? ctx.fmtMac(String(r.mac)) : "" }));
    const planSheets = (p, result) => {
      const info = [
        ["Org", ctx.orgName],
        ["Result", result || "Preview only: nothing sent"],
        ["Sites", p.payload.site_ids.length], ["APs", p.rows.length],
        ["Skipped by Mist (no force)", p.rows.filter((r) => r.note).length],
        ["Start", p.payload.start_datetime], ["Strategy", p.payload.strategy],
        ["Version", p.payload.versions[0].version], ["Force", String(p.payload.versions[0].force)],
        ["Reminder", WARNING],
        ["Request", `POST /orgs/${ctx.orgId}/devices/upgrade`], ["Body", JSON.stringify(p.payload, null, 2)],
        ["Generated", ctx.epochToUtc(Date.now())],
      ];
      return [
        ctx.xlsx.sheet("Upgrade Plan", planCols, shown(p.rows)),
        ctx.xlsx.sheet("Request", [{ header: "Field", width: 26 }, { header: "Value", width: 90, wrap: true }], info,
          { autofilter: false, freeze: null }),
      ];
    };

    $("#asuPreview").onclick = () => {
      const p = current();
      $("#asuProblems").innerHTML = p.problems.length
        ? `<ul class="checklist crit">${p.problems.map((x) => `<li>${E(x)}</li>`).join("")}</ul>` : "";
      if (p.problems.length) { stale(); $("#asuPlan").innerHTML = ""; return; }
      state.previewKey = JSON.stringify(p.payload);
      $("#asuSchedule").disabled = false;
      const skipped = p.rows.filter((r) => r.note).length;
      setMsg("#asuState", `Dry run: ${p.rows.length} AP(s) at ${p.payload.site_ids.length} site(s) are in scope`
        + `${skipped ? `, ${skipped} of them already at or above ${p.payload.versions[0].version} and skipped by Mist` : ""}. Nothing was sent.`);
      ctx.log(`Preview: ${p.rows.length} AP(s), ${p.payload.models.join(", ")} → ${p.payload.versions[0].version}`, "info");
      $("#asuPlan").innerHTML = `${ctx.previewTable(planCols, shown(p.rows))}
        <p class="asu-note" style="margin:.8rem 0 .3rem">Request that Schedule will send: POST /orgs/${E(ctx.orgId)}/devices/upgrade</p>
        <pre id="asuJson">${E(JSON.stringify(p.payload, null, 2))}</pre>
        <div class="actions"><button class="btn btn-s" type="button" id="asuPlanXlsx">Download plan (.xlsx)</button></div>`;
      $("#asuPlanXlsx").onclick = () => downloadXlsx("mist_ap_upgrade_plan", planSheets(p));
    };

    $("#asuSchedule").onclick = async () => {
      const p = current();
      if (p.problems.length || JSON.stringify(p.payload) !== state.previewKey) { stale(); return; }
      if (!confirmChange(`Schedule a firmware upgrade of ${p.rows.length} AP(s) at ${p.payload.site_ids.length} site(s) to `
        + `${p.payload.versions[0].version} (${p.payload.strategy}), starting ${p.payload.start_datetime}?`)) {
        setMsg("#asuState", "Not scheduled. Nothing was sent.");
        return;
      }
      $("#asuSchedule").disabled = true;
      try {
        const res = await scheduleUpgrade(ctx, p.payload);
        state.lastId = res.id || "";
        state.previewKey = "";
        state.log = null;
        setMsg("#asuState", res.id ? `Upgrade scheduled. Upgrade ID: ${res.id}` : "Upgrade request sent; Mist returned no ID.", "good");
        $("#asuPlan").insertAdjacentHTML("afterbegin",
          `<p class="good asu-msg"><strong>Scheduled.</strong> Upgrade ID <span class="mono" id="asuNewId">${E(res.id || "")}</span>${
            (res.site_upgrades || []).length ? ` · ${res.site_upgrades.length} site upgrade(s)` : ""}. Use the Status tab to follow it.</p>
           <div class="actions"><button class="btn btn-s" type="button" id="asuRecXlsx">Download record (.xlsx)</button></div>`);
        $("#asuRecXlsx").onclick = () => downloadXlsx("mist_ap_upgrade_scheduled",
          planSheets(p, `Scheduled, upgrade ID ${res.id || "(none returned)"}`));
      } catch (e) {
        setMsg("#asuState", e.message, "crit");
        ctx.log(e.message, "err");
        $("#asuSchedule").disabled = false;
      }
    };

    // ---- log, status and cancel
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
      }).join("") || '<option value="">No AP upgrades listed</option>';
      for (const sel of ["#asuStatusPick", "#asuCancelPick"]) {
        $(sel).innerHTML = opts;
        if (state.lastId && state.upgrades.some((u) => u.upgrade_id === state.lastId)) $(sel).value = state.lastId;
      }
      if (state.lastId && !state.upgrades.some((u) => u.upgrade_id === state.lastId)) {
        $("#asuStatusId").value ||= state.lastId;
        $("#asuCancelId").value ||= state.lastId;
      }
    }
    const chosenId = (pick, typed) => $(typed).value.trim() || $(pick).value;

    const renderLog = () => {
      const all = state.log?.rows || [];
      const rows = all.filter((r) => !state.logPhase || r.phase === state.logPhase);
      const n = (ph) => all.filter((r) => r.phase === ph).length;
      setMsg("#asuLogMsg", `${all.length} AP upgrade(s): ${n("Pending")} pending, ${n("In progress")} in progress, `
        + `${n("Finished")} finished${n("Unknown") ? `, ${n("Unknown")} unknown` : ""}.`
        + (state.log?.failed ? ` ${state.log.failed} could not be read.` : ""), state.log?.failed ? "warn" : "muted");
      const tone = (r) => (r.phase === "Pending" ? "accent" : r.phase === "In progress" ? "warn"
        : /fail|error/i.test(r.status) || r.failed ? "crit" : r.phase === "Finished" ? "good" : "subtle");
      const cell = (v) => `<td>${E(v === null || v === undefined || v === "" ? "—" : v)}</td>`;
      $("#asuLogOut").innerHTML = rows.length ? `<div class="res-scroll"><table class="ap-table"><thead><tr>
          <th>Upgrade ID</th><th>Status</th><th>Start</th><th>Sites</th><th>APs</th><th>Upgraded</th><th>Failed</th>
          <th>Skipped</th><th>Version</th><th>Strategy</th></tr></thead><tbody>${rows.map((r) => `<tr>
          <td><button class="asu-id" type="button" data-log-id="${E(r.upgrade_id)}" title="Show status">${E(r.upgrade_id)}</button></td>
          <td class="${tone(r)}">${E(r.phase)}${r.status && r.status.toLowerCase() !== r.phase.toLowerCase() ? ` · ${E(r.status)}` : ""}</td>
          ${cell(r.startMs ? ctx.fmtTime(r.startMs) : r.start)}
          <td title="${E(r.site_names)}">${E(r.site_count)}${r.site_names ? ` · ${E(r.site_names.length > 60 ? `${r.site_names.slice(0, 57)}…` : r.site_names)}` : ""}</td>
          ${cell(r.devices)}${cell(r.upgraded)}${cell(r.failed)}${cell(r.skipped)}${cell(r.versions)}${cell(r.reboot_strategy)}</tr>`).join("")}
        </tbody></table></div>`
        : `<p class="muted asu-msg">${all.length ? "No upgrade in this group." : "Mist lists no AP upgrades for this org."}</p>`;
      $$("[data-log-id]").forEach((b) => { b.onclick = () => {
        $("#asuStatusId").value = b.dataset.logId;
        root.querySelector('[data-tab="status"]').click();
        $("#asuStatusGo").click();
      }; });
    };

    async function loadLogTab(force = false) {
      $("#asuLogRefresh").disabled = true;
      setMsg("#asuLogMsg", "Reading the org's upgrades…");
      try {
        await ensureLog(force);
        $("#asuLogXlsx").disabled = false;
        renderLog();
      } catch (e) {
        setMsg("#asuLogMsg", `Could not list upgrades: ${e.message}`, "crit");
      } finally {
        $("#asuLogRefresh").disabled = false;
      }
    }

    $$("[data-phase]").forEach((b) => { b.onclick = () => {
      $$("[data-phase]").forEach((x) => x.classList.toggle("on", x === b));
      state.logPhase = b.dataset.phase;
      renderLog();
    }; });
    $("#asuLogRefresh").onclick = () => loadLogTab(true);
    $("#asuLogXlsx").onclick = () => {
      const rows = state.log?.rows || [];
      downloadXlsx("mist_ap_upgrade_log", [
        ctx.xlsx.sheet("Upgrade Log", LOG_COLUMNS, rows),
        ctx.xlsx.sheet("Info", [{ header: "Field" }, { header: "Value", wrap: true }], [
          ["Org", ctx.orgName], ["Upgrades", rows.length],
          ["Source", `GET /orgs/${ctx.orgId}/devices/upgrade, then each upgrade by ID`],
          ["Generated", ctx.epochToUtc(Date.now())],
        ], { autofilter: false, freeze: null }),
      ]);
    };

    $("#asuStatusGo").onclick = async () => {
      const id = chosenId("#asuStatusPick", "#asuStatusId");
      if (!id) { setMsg("#asuStatusMsg", "Choose or type an upgrade ID.", "crit"); return; }
      setMsg("#asuStatusMsg", "Reading…");
      try {
        const data = await readUpgrade(ctx, id);
        const names = Object.fromEntries(state.sites.map((s) => [s.id, s.name]));
        const { columns, rows } = flattenStatus(data, names, macName());
        setMsg("#asuStatusMsg", `Upgrade ${id}${data.status ? ` (${data.status})` : ""}: ${rows.length} device(s).`);
        const facts = [["Start", data.start_datetime], ["Strategy", data.strategy ?? data.reboot_strategy],
          ["Version", data.target_version ?? (data.versions || []).map((v) => v.version).filter(Boolean).join(", ")],
          ["Force", data.force]];
        const when = facts.filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}: ${v}`).join(" · ");
        $("#asuStatusOut").innerHTML = `<p class="asu-note" style="margin:0 0 .5rem">${E(when || "Mist gave no schedule details.")}</p>
          ${ctx.previewTable(screenStatusColumns(columns), rows)}
          <div class="actions" style="margin-top:.6rem"><button class="btn btn-s" type="button" id="asuStatusXlsx">Download status (.xlsx)</button></div>`;
        $("#asuStatusXlsx").onclick = () => downloadXlsx("mist_ap_upgrade_status", [
          ctx.xlsx.sheet("Upgrade Status", columns, rows),
          ctx.xlsx.sheet("Info", [{ header: "Field" }, { header: "Value", wrap: true }], [
            ["Org", ctx.orgName], ["Upgrade ID", id], ["Status", data.status ?? ""],
            ...facts.map(([k, v]) => [k, v ?? "N/A"]),
            ["Generated", ctx.epochToUtc(Date.now())],
          ], { autofilter: false, freeze: null }),
        ]);
      } catch (e) {
        setMsg("#asuStatusMsg", e.message, "crit");
      }
    };

    $("#asuCancelGo").onclick = async () => {
      const id = chosenId("#asuCancelPick", "#asuCancelId");
      if (!id) { setMsg("#asuCancelMsg", "Choose or type an upgrade ID.", "crit"); return; }
      try {
        const data = await readUpgrade(ctx, id);
        if (isFinished(data)) {
          setMsg("#asuCancelMsg", `Upgrade ${id} is already ${data.status || "finished"}; nothing to cancel. Nothing was sent.`);
          return;
        }
        if (!confirmChange(`Cancel upgrade ${id}${data.status ? ` (${data.status})` : ""}, covering ${(data.upgrades || []).length} site(s)?`)) {
          setMsg("#asuCancelMsg", "Not cancelled. Nothing was sent.");
          return;
        }
        setMsg("#asuCancelMsg", await cancelUpgrade(ctx, id), "good");
        state.log = null;
      } catch (e) {
        setMsg("#asuCancelMsg", e.message, "crit");
      }
    };

    // ---- start: the org's sites
    renderVersion();
    try {
      state.sites = (await ctx.listSites()).map((s) => ({ id: s.id, name: s.name || s.id }));
      renderSites();
    } catch (e) {
      setMsg("#asuCount", `Could not list sites: ${e.message}`, "crit");
    }
  },

  // mount() owns the view; run() exists so the tool shape stays uniform.
  async run() {
    return { rendered: true };
  },
};
