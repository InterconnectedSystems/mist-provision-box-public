// Ported from mist_switch_report.js (a Node CLI script).
//
// The original prompted for a token on the terminal, hardcoded api.gc2.mist.com,
// and wrote through ExcelJS. Here the shell supplies the token, region and org,
// and the workbook goes through lib/xlsx.js. The row shaping — switchRow,
// vcMembers, formatUptime, formatEpoch — is carried over unchanged.
//
// One deliberate behaviour change: the script's getAll stopped on a short page,
// which truncates when Mist returns 100 rows while echoing limit=1000. The
// shared getAll walks X-Page-Total instead.

export default {
  id: "switch-report",
  name: "Switch Software Report",
  description: "Every switch at one site or across an org, site by site, with model, serial, MAC, software "
    + "version, status, IP, uptime and per-member versions for Virtual Chassis.",
  tag: "Mist API",
  needs: { mistToken: true, org: true },
  scope: "site",
  params: [],

  async run(ctx) {
    const { getAll, pool, POOL_LIMIT, log, progress } = ctx;

    log(`Org: ${ctx.orgName}`, "info");

    const scope = await ctx.targetSites();
    const { sites } = scope;
    log(`Scope: ${scope.label}.`, "info");

    const errors = [];
    let done = 0;
    const perSite = await pool(POOL_LIMIT, sites.map((site) => async () => {
      if (ctx.signal.aborted) return [];
      try {
        const switches = await getAll(`/sites/${site.id}/stats/devices`, { type: "switch" });
        return (Array.isArray(switches) ? switches : []).sort(byName).map((sw) => switchRow(site, sw));
      } catch (e) {
        errors.push([site.name || site.id, e.message]);
        return [];
      } finally {
        done += 1;
        progress(done, sites.length, "sites");
      }
    }));
    // pool() keeps input order, so rows stay grouped by the sorted site list.
    const rows = perSite.flat();

    const versions = new Set(rows.map((r) => r.version).filter(Boolean));
    if (errors.length) log(`${errors.length} site(s) had errors: ${errors.map((e) => e[0]).join(", ")}`, "err");
    log(`${rows.length} switch(es) across ${sites.length} site(s), `
      + `${versions.size} distinct software version(s).`, "ok");

    const columns = [
      { header: "Site", key: "site" },
      { header: "Switch Name", key: "name" },
      { header: "Model", key: "model" },
      { header: "Serial", key: "serial" },
      { header: "MAC", key: "mac" },
      { header: "Software Version", key: "version" },
      { header: "Status", key: "status" },
      { header: "IP", key: "ip" },
      { header: "Uptime", key: "uptime" },
      { header: "Last Seen", key: "lastSeen" },
      { header: "VC Members", key: "vcCount" },
      { header: "VC Member Versions", key: "vcDetail" },
      { header: "Site ID", key: "siteId" },
      { header: "Device ID", key: "deviceId" },
    ];

    return {
      summary: `${rows.length} switch(es) across ${sites.length} site(s), `
        + `${versions.size} distinct software version(s)`
        + (errors.length ? `, ${errors.length} site(s) unreadable` : ""),
      filename: ctx.stampedName("mist_switches", scope.fileLabel, "xlsx"),
      sheets: [ctx.xlsx.sheet("Switches", columns, rows, { tabColor: "1F4E78" })],
      preview: { title: "Switches", columns, rows },
    };
  },
};

function byName(a, b) {
  return (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" });
}

export function formatUptime(seconds) {
  if (!seconds) return "";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

/** Local time, as the original printed it. */
export function formatEpoch(epoch) {
  if (!epoch) return "";
  const dt = new Date(epoch * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} `
    + `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

/** Virtual Chassis members, e.g. "fpc0 master XX123 (23.4R2-S3); fpc1 backup XX456 (23.4R2-S3)". */
export function vcMembers(sw) {
  const mods = (sw.module_stat || []).filter((m) => m.serial);
  if (mods.length < 2) return { count: mods.length || 1, detail: "" };
  const detail = mods
    .map((m, i) => {
      const idx = m.fpc_idx ?? m._idx ?? i;
      const role = m.vc_role ? ` ${m.vc_role}` : "";
      return `fpc${idx}${role} ${m.serial} (${m.version || "?"})`;
    })
    .join("; ");
  return { count: mods.length, detail };
}

export function switchRow(site, sw) {
  const vc = vcMembers(sw);
  return {
    site: site.name || site.id,
    name: sw.name || sw.hostname || "",
    model: sw.model || "",
    serial: sw.serial || "",
    mac: sw.mac || "",
    version: sw.version || "",
    status: sw.status || "",
    ip: sw.ip || (sw.ip_stat && sw.ip_stat.ip) || "",
    uptime: formatUptime(sw.uptime),
    lastSeen: formatEpoch(sw.last_seen),
    vcCount: vc.count,
    vcDetail: vc.detail,
    siteId: site.id,
    deviceId: sw.id || "",
  };
}
