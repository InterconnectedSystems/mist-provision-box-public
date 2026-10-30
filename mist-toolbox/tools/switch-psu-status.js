// Switch PSU Status: power supply health for every switch in the org or one
// site, drawn as an on-screen dashboard plus an .xlsx.
// Source: GET /sites/{site_id}/stats/devices?type=switch -> module_stat[].psus[]
// Each virtual-chassis member (module_stat entry) is judged on its own, and the
// switch takes the worst member's result. The org inventory says which members a
// VC should have, so a member that stops reporting is flagged, not just dropped.
// Modules without PSUs (CX management modules, line cards, fan trays) are
// skipped, and PSU modules with no FPC or VC role are pooled as one chassis.

// Raw Junos/Mist PSU status -> class. Edit these lists if your switches report
// other words. Anything not listed is "unknown" (raw text is always kept).
// Junos "Present" means installed but not supplying power (no cord, no input).
const PSU_OK = ["ok", "online", "normal", "good", "powered", "on"];
const PSU_NOPOWER = ["present", "no input", "unpowered"];
const PSU_ABSENT = ["absent", "not present", "not-present", "empty", "missing", "not installed"];
const PSU_FAILED = ["failed", "fail", "failure", "check", "error", "offline", "off", "down", "faulty", "alarm", "no power"];

const PSU = {
  ok: { label: "OK", color: "#2e7d32" },
  failed: { label: "Failed", color: "#d32f2f" },
  nopower: { label: "No power", color: "#e65100" },
  absent: { label: "Empty slot", color: "#9e9e9e" },
  unknown: { label: "Unknown", color: "#5c6bc0" },
};
const HEALTH = {
  failed: { label: "PSU failed / no power", color: "#d32f2f", rank: 0, style: "red" },
  missing: { label: "Member missing", color: "#8e24aa", rank: 1, style: "red" },
  single: { label: "Not redundant", color: "#f57c00", rank: 2, style: "yellow" },
  nodata: { label: "No PSU data", color: "#757575", rank: 3, style: undefined },
  redundant: { label: "Redundant", color: "#2e7d32", rank: 4, style: "green" },
};
const HEALTH_KEYS = ["failed", "missing", "single", "nodata", "redundant"];
const ATTENTION = ["failed", "missing", "single"];

// module_stat vc_state values that mean the member is not in the VC right now.
const NOT_PRESENT = /not|absent|inactive|unknown/i;

const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

function classify(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "unknown";
  if (PSU_ABSENT.includes(s)) return "absent";
  if (PSU_NOPOWER.includes(s)) return "nopower";
  if (PSU_FAILED.includes(s) || s.includes("fail")) return "failed";
  if (PSU_OK.includes(s)) return "ok";
  return "unknown";
}

function memberHealth(psus) {
  const n = (c) => psus.filter((p) => p.cls === c).length;
  if (n("failed") || n("nopower")) return "failed";
  if (n("ok") >= 2) return "redundant";
  if (n("ok") === 1) return "single";
  return "nodata";
}

const normMac = (v) => String(v || "").toLowerCase().replace(/[^0-9a-f]/g, "");

/** "FPC 2", or "Chassis" for pooled CX PSU modules. */
const memberLabel = (m) => (m.idx === "chassis" ? "Chassis" : `FPC ${m.idx}`);

const worst = (keys) =>
  keys.reduce((w, k) => (HEALTH[k].rank < HEALTH[w].rank ? k : w), "redundant");

export default {
  id: "switch-psu-status",
  name: "Switch PSU Status",
  description:
    "Shows the power supply status of every switch in the org or one site as a dashboard, " +
    "flagging failed supplies and switches without PSU redundancy.",
  tag: "Mist API",
  needs: { mistToken: true, org: true },
  params: [
    {
      id: "allSites",
      type: "checkbox",
      label: "All sites in the org",
      default: true,
      hint: "When ticked, the Site dropdown is ignored.",
    },
    {
      id: "siteId",
      type: "select",
      label: "Site",
      optionsFrom: "sites",
      hint: "Used only when \"All sites in the org\" is unticked.",
    },
    {
      id: "includeOffline",
      type: "checkbox",
      label: "Include disconnected switches (last known PSU status)",
      default: true,
    },
  ],

  async run(ctx) {
    const { allSites, siteId, includeOffline } = ctx.params;

    const sites = await ctx.listSites();
    let targets;
    if (allSites) {
      targets = sites;
      if (!targets.length) throw new Error("This org has no sites.");
    } else {
      if (!siteId) throw new Error("Pick a site, or tick \"All sites in the org\".");
      targets = [sites.find((x) => x.id === siteId) || { id: siteId, name: siteId }];
    }
    const siteName = (s) => s.name || s.id;
    const scopeLabel = allSites ? `all ${targets.length} sites` : siteName(targets[0]);

    // ---- Collect ----------------------------------------------------------
    ctx.status(`Loading switch stats for ${scopeLabel}\u2026`);
    let done = 0;
    const failedSites = [];
    const perSite = await ctx.pool(
      ctx.POOL_LIMIT,
      targets.map((site) => async () => {
        if (ctx.signal.aborted) return [];
        try {
          const stats = await ctx.getAll(`/sites/${site.id}/stats/devices`, { type: "switch", limit: 1000 });
          return stats
            .filter((d) => !d.type || d.type === "switch")
            .map((d) => ({ ...d, __site: siteName(site) }));
        } catch (e) {
          failedSites.push({ site: siteName(site), error: e.message });
          ctx.log(`${siteName(site)}: ${e.message}`, "err");
          return [];
        } finally {
          ctx.progress(++done, targets.length, siteName(site));
        }
      }),
    );
    if (ctx.signal.aborted) throw new Error("Cancelled.");

    // VC membership from the org inventory: chassis MAC -> expected members.
    // Without it a member missing from module_stat cannot be noticed, so a
    // failure here only turns that check off.
    const expected = new Map();
    try {
      const inventory = await ctx.getAll(`/orgs/${ctx.orgId}/inventory`, { type: "switch", vc: true });
      for (const item of inventory) {
        const key = normMac(item.vc_mac);
        if (!key) continue;
        expected.set(key, [...(expected.get(key) || []), item]);
      }
      // Mist lists a VC's virtual chassis as a row whose serial is the VC MAC;
      // it is not a physical member. Only a group of 2+ real members is a VC.
      for (const [key, rows] of expected) {
        const real = rows.filter((r) => normMac(r.serial) !== key && normMac(r.serial) !== normMac(r.mac));
        if (real.length > 1) expected.set(key, real);
        else expected.delete(key);
      }
    } catch (e) {
      ctx.log(`Inventory: ${e.message}; missing VC members cannot be detected`, "err");
    }

    // ---- Shape ------------------------------------------------------------
    const switches = perSite.flat()
      .map((d) => {
        const online = String(d.status || "").toLowerCase() === "connected";
        const toPsus = (arr, offset = 0) => arr.map((p, j) => ({
          name: p?.name || `PSU ${j + offset}`,
          raw: p?.status ?? "",
          cls: classify(p?.status),
        })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        const members = [];
        const pooled = [];
        list(d.module_stat).forEach((m, i) => {
          if (!m || typeof m !== "object") return;
          const raw = list(m.psus);
          const absent = NOT_PRESENT.test(String(m.vc_state || ""));
          const isMember = m.fpc_idx != null || m.vc_role;
          // CX PSU modules: PSUs with no FPC or VC role belong to the chassis.
          if (!isMember) { pooled.push(...raw); return; }
          // A module with no PSUs (management module, line card) says nothing
          // about power, unless it is a VC member that is not present.
          if (!raw.length && !absent) return;
          const psus = toPsus(raw);
          members.push({
            idx: m.fpc_idx ?? m.idx ?? i,
            role: m.vc_role || "",
            model: m.model || d.model || "",
            serial: m.serial || "",
            mac: normMac(m.mac),
            psus,
            // A not-present member keeps its last PSU readings; they are shown
            // but cannot vouch for it.
            missing: absent,
            health: absent ? "missing" : memberHealth(psus),
          });
        });
        if (pooled.length) {
          const psus = toPsus(pooled);
          members.push({ idx: "chassis", role: "", model: d.model || "", serial: "", mac: "", psus,
            missing: false, health: memberHealth(psus) });
        }
        const reporting = members.length;
        // No member data at all (e.g. disconnected) is "No PSU data", not missing.
        const inv = reporting ? expected.get(normMac(d.vc_mac || d.mac)) || [] : [];
        for (const e of inv) {
          const serial = String(e.serial || "").toUpperCase();
          const mac = normMac(e.mac);
          const found = members.some((m) =>
            (serial && m.serial.toUpperCase() === serial) || (!serial && mac && m.mac === mac));
          if (!found) {
            members.push({
              idx: "?", role: "", model: e.model || d.model || "", serial: e.serial || mac,
              mac, psus: [], missing: true, health: "missing",
            });
          }
        }
        const order = (m) => (m.idx === "?" ? 1e6 : m.idx === "chassis" ? -1 : Number(m.idx));
        members.sort((a, b) => order(a) - order(b));
        return {
          site: d.__site,
          name: d.name || ctx.fmtMac(String(d.mac || "")) || d.id,
          mac: d.mac ? ctx.fmtMac(String(d.mac)) : "",
          model: d.model || "",
          version: d.version || "",
          online,
          members,
          expected: Math.max(inv.length, members.length),
          health: members.length ? worst(members.map((m) => m.health)) : "nodata",
        };
      })
      .filter((s) => includeOffline || s.online)
      .sort((a, b) => a.site.localeCompare(b.site) || a.name.localeCompare(b.name));

    const psuRows = [];
    for (const sw of switches) {
      for (const m of sw.members) {
        if (m.missing && !m.psus.length) {
          psuRows.push({
            site: sw.site, switch: sw.name, model: m.model, member: m.idx, role: m.role,
            serial: m.serial, psu: "", raw: "not reporting", cls: HEALTH.missing.label,
            online: sw.online ? "Connected" : "Disconnected", __style: "red",
          });
        }
        for (const p of m.psus) {
          psuRows.push({
            site: sw.site, switch: sw.name, model: m.model, member: m.idx, role: m.role,
            serial: m.serial, psu: p.name, raw: p.raw, cls: PSU[p.cls].label,
            online: sw.online ? "Connected" : "Disconnected",
            __style: p.cls === "failed" || p.cls === "nopower" || m.missing ? "red"
              : p.cls === "unknown" ? "yellow" : undefined,
          });
        }
      }
    }

    const count = (arr, f) => arr.filter(f).length;
    const totals = Object.fromEntries(HEALTH_KEYS.map((k) => [k, count(switches, (s) => s.health === k)]));
    const allPsus = switches.flatMap((s) => s.members.flatMap((m) => m.psus));
    const psuTotals = Object.fromEntries(Object.keys(PSU).map((k) => [k, count(allPsus, (p) => p.cls === k)]));
    const offline = count(switches, (s) => !s.online);

    const bySite = new Map();
    for (const sw of switches) {
      const r = bySite.get(sw.site) || { site: sw.site, total: 0, failed: 0, missing: 0, single: 0, nodata: 0, redundant: 0, offline: 0 };
      r.total += 1;
      r[sw.health] += 1;
      if (!sw.online) r.offline += 1;
      bySite.set(sw.site, r);
    }
    const siteRows = [...bySite.values()].sort((a, b) =>
      b.failed - a.failed || b.missing - a.missing || b.single - a.single || a.site.localeCompare(b.site));

    ctx.log(`${switches.length} switch(es), ${allPsus.length} PSU(s): ` +
      `${psuTotals.failed} failed, ${psuTotals.nopower} without power, ${totals.missing} VC(s) missing a member, ` +
      `${totals.single} switch(es) not redundant`,
      psuTotals.failed || psuTotals.nopower || totals.missing ? "err" : "ok");

    // ---- Dashboard --------------------------------------------------------
    if (ctx.mount) drawDashboard(ctx, { switches, siteRows, totals, psuTotals, offline, scopeLabel });

    // ---- Workbook ---------------------------------------------------------
    const switchCols = [
      { header: "Site", key: "site", width: 30 },
      { header: "Switch", key: "name", width: 26 },
      { header: "Model", key: "model", width: 14 },
      { header: "MAC", key: "mac", width: 18 },
      { header: "State", key: "state", width: 13 },
      { header: "VC Members", key: "members", width: 10 },
      { header: "PSUs OK", key: "ok", width: 9 },
      { header: "PSUs Failed", key: "failed", width: 10 },
      { header: "PSUs No Power", key: "nopower", width: 10 },
      { header: "Empty Slots", key: "absent", width: 10 },
      { header: "PSUs Unknown", key: "unknown", width: 10 },
      { header: "PSU Health", key: "health", width: 16 },
      { header: "Detail", key: "detail", width: 60, wrap: true },
    ];
    const switchRows = [...switches]
      .sort((a, b) => HEALTH[a.health].rank - HEALTH[b.health].rank || a.site.localeCompare(b.site))
      .map((s) => {
        const ps = s.members.flatMap((m) => m.psus);
        return {
          site: s.site, name: s.name, model: s.model, mac: s.mac,
          state: s.online ? "Connected" : "Disconnected",
          members: s.members.some((m) => m.missing)
            ? `${s.members.filter((m) => !m.missing).length}/${s.expected}`
            : s.members.length,
          ok: count(ps, (p) => p.cls === "ok"),
          failed: count(ps, (p) => p.cls === "failed"),
          nopower: count(ps, (p) => p.cls === "nopower"),
          absent: count(ps, (p) => p.cls === "absent"),
          unknown: count(ps, (p) => p.cls === "unknown"),
          health: HEALTH[s.health].label,
          detail: s.members.map((m) =>
            `${s.members.length > 1 ? `${memberLabel(m)}: ` : ""}` +
            (m.missing ? `${m.serial || "member"} not reporting${m.psus.length ? " (last: " : ""}` : "") +
            (m.psus.length ? m.psus.map((p) => `${p.name}=${p.raw || "?"}`).join(", ") : m.missing ? "" : "no PSU data") +
            (m.missing && m.psus.length ? ")" : "")).join("\n"),
          __style: HEALTH[s.health].style === "green" ? undefined : HEALTH[s.health].style,
        };
      });
    const psuCols = [
      { header: "Site", key: "site", width: 30 },
      { header: "Switch", key: "switch", width: 26 },
      { header: "Member Model", key: "model", width: 14 },
      { header: "FPC", key: "member", width: 6 },
      { header: "VC Role", key: "role", width: 10 },
      { header: "Member Serial", key: "serial", width: 16 },
      { header: "PSU", key: "psu", width: 18 },
      { header: "Reported Status", key: "raw", width: 16 },
      { header: "Class", key: "cls", width: 12 },
      { header: "Switch State", key: "online", width: 13 },
    ];
    const siteCols = [
      { header: "Site", key: "site", width: 30 },
      { header: "Switches", key: "total" },
      { header: "PSU Failed", key: "failed" },
      { header: "Member Missing", key: "missing" },
      { header: "Not Redundant", key: "single" },
      { header: "No PSU Data", key: "nodata" },
      { header: "Redundant", key: "redundant" },
      { header: "Disconnected", key: "offline" },
    ];
    const info = [
      ["Org", ctx.orgName],
      ["Scope", allSites ? "All sites" : siteName(targets[0])],
      ["Sites queried", targets.length],
      ["Sites that failed", failedSites.length],
      ["Switches", switches.length],
      ["Disconnected switches", includeOffline ? `${offline} (last known status shown)` : "excluded"],
      ["PSUs OK / failed / no power / empty / unknown",
        `${psuTotals.ok} / ${psuTotals.failed} / ${psuTotals.nopower} / ${psuTotals.absent} / ${psuTotals.unknown}`],
      ["Redundant", "Every member has 2 or more PSUs reporting OK"],
      ["Member missing", "A VC member in the org inventory is not reporting, or reports as not present"],
      ["Not redundant", "A member has exactly 1 PSU reporting OK (includes single-PSU models)"],
      ["PSU failed / no power", "A member has a PSU reporting failed, check, offline or similar, "
        + "or one that is installed but not supplying power (Junos \"Present\")"],
      ["Generated", ctx.epochToUtc(Date.now())],
    ];
    const sheets = [
      ctx.xlsx.sheet("Switches", switchCols, switchRows, { tabColor: "1F4E78" }),
      ctx.xlsx.sheet("PSUs", psuCols, psuRows, { tabColor: "C55A11" }),
      ctx.xlsx.sheet("By Site", siteCols, siteRows.map((r) => ({
        ...r, __style: r.failed || r.missing ? "red" : r.single ? "yellow" : undefined })), { tabColor: "548235" }),
    ];
    if (failedSites.length) {
      sheets.push(ctx.xlsx.sheet("Failed Sites",
        [{ header: "Site", key: "site" }, { header: "Error", key: "error", wrap: true }],
        failedSites, { tabColor: "7F7F7F" }));
    }
    sheets.push(ctx.xlsx.sheet("Info", [{ header: "Field" }, { header: "Value", wrap: true }], info,
      { autofilter: false, freeze: null }));

    const scopeName = allSites ? "all_sites" : ctx.safeName(siteName(targets[0]));
    const failNote = failedSites.length ? `, ${failedSites.length} site(s) failed` : "";
    return {
      summary: `${switches.length} switch(es): ${totals.failed} with a failed or unpowered PSU, ` +
        `${totals.missing} with a missing member, ` +
        `${totals.single} not redundant, ${totals.redundant} redundant${failNote}`,
      filename: ctx.stampedName(`mist_switch_psu_${scopeName}`, ctx.orgName, "xlsx"),
      sheets,
    };
  },
};

// ---------------------------------------------------------------------------
// On-screen dashboard: summary tiles, a stacked bar per site, and a card per
// switch showing each PSU. Filters: needs-attention toggle, text search, and
// clicking a site bar to focus that site.
function drawDashboard(ctx, { switches, siteRows, totals, psuTotals, offline, scopeLabel }) {
  const E = ctx.esc;
  const state = { issuesOnly: ATTENTION.some((k) => totals[k] > 0), q: "", site: "" };

  const tile = (n, label, color) =>
    `<div class="psu-tile" style="border-top-color:${color}"><b>${n}</b><span>${E(label)}</span></div>`;

  const bar = (r) => HEALTH_KEYS.filter((k) => r[k]).map((k) =>
    `<i style="width:${(r[k] / r.total) * 100}%;background:${HEALTH[k].color}" ` +
    `title="${E(`${HEALTH[k].label}: ${r[k]}`)}"></i>`).join("");

  const pill = (p) => {
    const num = (String(p.name).match(/(\d+)\s*$/) || [])[1];
    return `<span class="psu-pill" style="background:${PSU[p.cls].color}" ` +
      `title="${E(`${p.name}: ${p.raw || "no status"}${p.cls === "nopower" ? " (installed, not supplying power)" : ""}`)}">${E(num != null ? `PSU ${num}` : p.name)}</span>`;
  };

  const card = (s) => {
    const members = s.members.length
      ? s.members.map((m) =>
          `<div class="psu-mem">${s.members.length > 1
            ? `<em>${E(memberLabel(m))}${m.role ? ` \u00b7 ${E(m.role)}` : ""}</em>` : ""}` +
          (m.missing
            ? `<span class="psu-miss">${E(m.serial || "member")} \u00b7 not reporting</span>`
            : m.psus.length ? m.psus.map(pill).join("") : `<span class="psu-none">no PSU data</span>`) +
          `</div>`).join("")
      : `<div class="psu-mem"><span class="psu-none">no PSU data</span></div>`;
    return `<div class="psu-card${s.online ? "" : " psu-off"}" style="border-left-color:${HEALTH[s.health].color}">` +
      `<div class="psu-card-h"><b title="${E(s.name)}">${E(s.name)}</b>` +
      `<span class="psu-tag" style="color:${HEALTH[s.health].color}">${E(HEALTH[s.health].label)}</span></div>` +
      `<div class="psu-sub">${E(s.model)}${s.online ? "" : " \u00b7 disconnected"}</div>${members}</div>`;
  };

  const legend =
    Object.values(PSU).map((p) => `<span><span class="psu-dot" style="background:${p.color}"></span>${E(p.label)}</span>`).join("") +
    `<span class="psu-sep"></span>` +
    HEALTH_KEYS.map((k) => `<span><span class="psu-dot psu-sq" style="background:${HEALTH[k].color}"></span>${E(HEALTH[k].label)}</span>`).join("");

  ctx.mount.innerHTML = `
<style>
  .psu-v{font:13px/1.4 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;color:inherit;margin-top:12px}
  .psu-v h3{font-size:14px;margin:18px 0 8px}
  .psu-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
  .psu-tile{border:1px solid rgba(128,128,128,.3);border-top:4px solid;border-radius:6px;padding:8px 10px}
  .psu-tile b{display:block;font-size:22px}
  .psu-tile span{opacity:.75;font-size:12px}
  .psu-legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin:10px 0;font-size:12px;opacity:.85;align-items:center}
  .psu-dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:-1px}
  .psu-sq{border-radius:2px}
  .psu-sep{width:1px;height:14px;background:rgba(128,128,128,.4)}
  .psu-sites{display:grid;gap:4px;max-height:320px;overflow:auto;padding-right:4px}
  .psu-srow{display:grid;grid-template-columns:minmax(120px,1.2fr) 3fr auto;gap:10px;align-items:center;
    padding:3px 6px;border-radius:4px;cursor:pointer}
  .psu-srow:hover,.psu-srow.on{background:rgba(128,128,128,.15)}
  .psu-srow span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .psu-bar{display:flex;height:12px;border-radius:3px;overflow:hidden;background:rgba(128,128,128,.15)}
  .psu-bar i{display:block;height:100%}
  .psu-cnt{font-size:12px;opacity:.8;white-space:nowrap}
  .psu-ctl{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:16px 0 8px}
  .psu-ctl button,.psu-ctl input{font:inherit;color:inherit;background:transparent;
    border:1px solid rgba(128,128,128,.45);border-radius:5px;padding:4px 10px}
  .psu-ctl button.on{background:rgba(128,128,128,.22);font-weight:600}
  .psu-ctl input{flex:1;min-width:160px}
  .psu-group{margin:14px 0 6px;font-weight:600}
  .psu-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px}
  .psu-card{border:1px solid rgba(128,128,128,.3);border-left:5px solid;border-radius:6px;padding:8px 10px}
  .psu-off{opacity:.6;border-style:dashed}
  .psu-card-h{display:flex;justify-content:space-between;gap:8px}
  .psu-card-h b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .psu-tag{font-size:11px;font-weight:600;white-space:nowrap}
  .psu-sub{font-size:12px;opacity:.7;margin-bottom:4px}
  .psu-mem{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-top:3px}
  .psu-mem em{font-style:normal;font-size:11px;opacity:.7;min-width:100%}
  .psu-pill{color:#fff;font-size:11px;font-weight:600;padding:1px 7px;border-radius:9px}
  .psu-none{font-size:12px;opacity:.6;font-style:italic}
  .psu-miss{font-size:12px;font-style:italic;font-weight:600;color:${HEALTH.missing.color}}
  .psu-empty{opacity:.7;font-style:italic;padding:8px 0}
</style>
<div class="psu-v">
  <div class="psu-tiles">
    ${tile(switches.length, `Switches (${scopeLabel})`, "#1f4e78")}
    ${tile(totals.failed, HEALTH.failed.label, HEALTH.failed.color)}
    ${tile(totals.missing, HEALTH.missing.label, HEALTH.missing.color)}
    ${tile(totals.single, HEALTH.single.label, HEALTH.single.color)}
    ${tile(totals.redundant, HEALTH.redundant.label, HEALTH.redundant.color)}
    ${tile(totals.nodata, HEALTH.nodata.label, HEALTH.nodata.color)}
    ${tile(`${psuTotals.failed + psuTotals.nopower}/${psuTotals.ok + psuTotals.failed + psuTotals.nopower + psuTotals.unknown}`,
      "PSUs failed or unpowered / installed", PSU.failed.color)}
    ${tile(offline, "Disconnected", "#9e9e9e")}
  </div>
  <div class="psu-legend">${legend}</div>
  <h3>By site <span class="psu-cnt">(click a site to focus it)</span></h3>
  <div class="psu-sites">${siteRows.map((r) =>
    `<div class="psu-srow" data-site="${E(r.site)}"><span title="${E(r.site)}">${E(r.site)}</span>` +
    `<div class="psu-bar">${bar(r)}</div>` +
    `<span class="psu-cnt">${r.failed ? `<b style="color:${HEALTH.failed.color}">${r.failed} failed</b> \u00b7 ` : ""}` +
    `${r.missing ? `<b style="color:${HEALTH.missing.color}">${r.missing} missing member</b> \u00b7 ` : ""}` +
    `${r.single ? `${r.single} not redundant \u00b7 ` : ""}${r.total} sw</span></div>`).join("")}</div>
  <div class="psu-ctl">
    <button data-mode="issues">Needs attention</button>
    <button data-mode="all">All switches</button>
    <input type="search" placeholder="Filter by switch, model or site\u2026">
  </div>
  <div class="psu-out"></div>
</div>`;

  const root = ctx.mount;
  const out = root.querySelector(".psu-out");

  const render = () => {
    const q = state.q.toLowerCase();
    const shown = switches.filter((s) =>
      (!state.issuesOnly || ATTENTION.includes(s.health)) &&
      (!state.site || s.site === state.site) &&
      (!q || `${s.name} ${s.model} ${s.site} ${s.mac}`.toLowerCase().includes(q)));
    shown.sort((a, b) => a.site.localeCompare(b.site) ||
      HEALTH[a.health].rank - HEALTH[b.health].rank || a.name.localeCompare(b.name));

    const groups = new Map();
    for (const s of shown) groups.set(s.site, [...(groups.get(s.site) || []), s]);
    out.innerHTML = shown.length
      ? [...groups].map(([site, list]) =>
          `<div class="psu-group">${E(site)} <span class="psu-cnt">(${list.length})</span></div>` +
          `<div class="psu-grid">${list.map(card).join("")}</div>`).join("")
      : `<div class="psu-empty">No switches match.${state.issuesOnly ? " No switch has a failed or unpowered PSU, a missing member or lost redundancy." : ""}</div>`;

    root.querySelectorAll("[data-mode]").forEach((b) =>
      b.classList.toggle("on", (b.dataset.mode === "issues") === state.issuesOnly));
    root.querySelectorAll(".psu-srow").forEach((r) =>
      r.classList.toggle("on", r.dataset.site === state.site));
  };

  root.querySelectorAll("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => { state.issuesOnly = b.dataset.mode === "issues"; render(); }));
  root.querySelector(".psu-ctl input").addEventListener("input", (e) => { state.q = e.target.value; render(); });
  root.querySelectorAll(".psu-srow").forEach((r) =>
    r.addEventListener("click", () => {
      state.site = state.site === r.dataset.site ? "" : r.dataset.site;
      render();
      out.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  render();
}
