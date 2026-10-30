// Site Alarms: every alarm/alert raised at one site, or at every site in the
// org, over the last 1 or 7 days.
// One site:  GET /sites/{site_id}/alarms/search (cursor paged).
// All sites: GET /sites/{site_id}/alarms/search for each site, run in parallel.
// When available, GET /const/alarm_defs turns alarm type keys into readable names.

const SEVERITY_ORDER = { critical: 0, major: 1, warn: 2, minor: 3, info: 4 };
const SEVERITY_STYLE = { critical: "red", major: "yellow", warn: "yellow" };

const list = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);

export default {
  id: "site-alarms",
  name: "Site Alarms",
  description:
    "Lists every alarm and alert raised at one site, or at every site in the org, " +
    "over the last day or week, with severity, affected devices and acknowledgement status.",
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
      id: "duration",
      type: "select",
      label: "Time range",
      options: [
        { value: "1d", label: "Past 1 day" },
        { value: "7d", label: "Past 7 days" },
      ],
      default: "1d",
    },
    {
      id: "severity",
      type: "select",
      label: "Severity",
      options: [
        { value: "", label: "All" },
        { value: "critical", label: "Critical" },
        { value: "major", label: "Major" },
        { value: "warn", label: "Warning" },
        { value: "minor", label: "Minor" },
        { value: "info", label: "Info" },
      ],
      default: "",
    },
    {
      id: "unackedOnly",
      type: "checkbox",
      label: "Only unacknowledged alarms",
      default: false,
    },
  ],

  async run(ctx) {
    const { allSites, siteId, duration, severity, unackedOnly } = ctx.params;

    const sites = await ctx.listSites();
    const siteNames = Object.fromEntries(sites.map((s) => [s.id, s.name || s.id]));

    let targets;
    if (allSites) {
      targets = sites;
      if (!targets.length) throw new Error("This org has no sites.");
    } else {
      if (!siteId) throw new Error("Pick a site, or tick \"All sites in the org\".");
      targets = [{ id: siteId, name: siteNames[siteId] || siteId }];
    }
    const scopeLabel = allSites ? `all ${targets.length} sites` : targets[0].name;

    ctx.status("Loading alarm definitions…");
    const defs = {};
    try {
      const raw = await ctx.mistGet("/const/alarm_defs");
      for (const d of list(raw)) if (d?.key) defs[d.key] = d;
    } catch (e) {
      ctx.log(`Alarm definitions unavailable, showing raw type keys (${e.message})`, "info");
    }

    // Query each site; one failing site is logged and skipped, not fatal.
    ctx.status(`Loading alarms for ${scopeLabel}…`);
    let done = 0;
    const failed = [];
    const perSite = await ctx.pool(
      ctx.POOL_LIMIT,
      targets.map((site) => async () => {
        if (ctx.signal.aborted) return [];
        let alarms = [];
        try {
          const res = await ctx.searchAll(`/sites/${site.id}/alarms/search`, {
            duration,
            limit: 1000,
          });
          alarms = Array.isArray(res) ? res : list(res?.results);
        } catch (e) {
          failed.push({ site: site.name || site.id, error: e.message });
          ctx.log(`${site.name || site.id}: ${e.message}`, "err");
        }
        ctx.progress(++done, targets.length, site.name || site.id);
        return alarms.map((a) => ({ ...a, site_id: a.site_id || site.id }));
      }),
    );
    if (ctx.signal.aborted) throw new Error("Cancelled.");

    const alarms = perSite.flat();
    ctx.log(`${alarms.length} alarm(s) returned for ${scopeLabel} (${duration})`, "ok");

    const rows = alarms
      .map((a) => {
        const def = defs[a.type] || {};
        const sev = String(a.severity || def.severity || "").toLowerCase();
        const devices = [...list(a.aps), ...list(a.switches), ...list(a.gateways)]
          .map((m) => ctx.fmtMac(String(m)));
        return {
          ts: Number(a.timestamp) || 0,
          site: siteNames[a.site_id] || a.site_id || "",
          first: a.timestamp ? ctx.fmtTime(a.timestamp) : "",
          last: a.last_seen ? ctx.fmtTime(a.last_seen) : "",
          severity: sev,
          group: a.group || def.group || "",
          type: a.type || "",
          name: def.display || a.type || "",
          count: a.count ?? "",
          hostnames: list(a.hostnames).join(", "),
          devices: devices.join(", "),
          reasons: list(a.reasons).join("; "),
          status: a.status || "",
          acked: a.acked ? "Yes" : "No",
          ackBy: a.ack_admin_name || "",
          note: a.note || "",
          id: a.id || "",
          __style: SEVERITY_STYLE[sev],
        };
      })
      .filter((r) => !severity || r.severity === severity)
      .filter((r) => !unackedOnly || r.acked === "No")
      .sort((x, y) => y.ts - x.ts);

    const columns = [
      { header: "Site", key: "site", width: 30 },
      { header: "First Seen", key: "first", width: 20 },
      { header: "Last Seen", key: "last", width: 20 },
      { header: "Severity", key: "severity", width: 10 },
      { header: "Group", key: "group", width: 14 },
      { header: "Alarm", key: "name", width: 34 },
      { header: "Type Key", key: "type", width: 28 },
      { header: "Count", key: "count", width: 8 },
      { header: "Hostnames", key: "hostnames", width: 30, wrap: true },
      { header: "Device MACs", key: "devices", width: 30, wrap: true },
      { header: "Reasons", key: "reasons", width: 40, wrap: true },
      { header: "Status", key: "status", width: 10 },
      { header: "Acked", key: "acked", width: 8 },
      { header: "Acked By", key: "ackBy", width: 18 },
      { header: "Note", key: "note", width: 30, wrap: true },
      { header: "Alarm ID", key: "id", width: 38 },
    ];

    // By Type: one line per alarm type, worst severity first.
    const byType = new Map();
    for (const r of rows) {
      const s = byType.get(r.type) ||
        { name: r.name, type: r.type, severity: r.severity, group: r.group, alarms: 0, events: 0, sites: new Set() };
      s.alarms += 1;
      s.events += Number(r.count) || 0;
      s.sites.add(r.site);
      byType.set(r.type, s);
    }
    const typeRows = [...byType.values()]
      .sort((a, b) =>
        (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) || b.alarms - a.alarms)
      .map(({ sites: set, ...s }) => ({ ...s, sites: set.size, __style: SEVERITY_STYLE[s.severity] }));
    const typeCols = [
      { header: "Alarm", key: "name" },
      { header: "Type Key", key: "type" },
      { header: "Severity", key: "severity" },
      { header: "Group", key: "group" },
      { header: "Alarms", key: "alarms" },
      { header: "Total Count", key: "events" },
      { header: "Sites Affected", key: "sites" },
    ];

    // By Site: alarm counts per site, busiest first. Sites with no alarms are included.
    const bySite = new Map(targets.map((t) => [
      siteNames[t.id] || t.id,
      { site: siteNames[t.id] || t.id, total: 0, critical: 0, major: 0, warn: 0, minor: 0, info: 0, unacked: 0 },
    ]));
    for (const r of rows) {
      const s = bySite.get(r.site);
      if (!s) continue;
      s.total += 1;
      if (r.severity in s) s[r.severity] += 1;
      if (r.acked === "No") s.unacked += 1;
    }
    const siteRows = [...bySite.values()]
      .sort((a, b) => b.critical - a.critical || b.total - a.total || a.site.localeCompare(b.site))
      .map((s) => ({ ...s, __style: s.critical ? "red" : s.major ? "yellow" : undefined }));
    const siteCols = [
      { header: "Site", key: "site", width: 30 },
      { header: "Alarms", key: "total" },
      { header: "Critical", key: "critical" },
      { header: "Major", key: "major" },
      { header: "Warning", key: "warn" },
      { header: "Minor", key: "minor" },
      { header: "Info", key: "info" },
      { header: "Unacknowledged", key: "unacked" },
    ];

    const rangeLabel = duration === "7d" ? "past 7 days" : "past 1 day";
    const sitesWithAlarms = siteRows.filter((s) => s.total).length;
    const info = [
      ["Org", ctx.orgName],
      ["Scope", allSites ? "All sites" : targets[0].name],
      ["Sites queried", targets.length],
      ["Sites with alarms", sitesWithAlarms],
      ["Sites that failed", failed.length],
      ["Time range", rangeLabel],
      ["Severity filter", severity || "All"],
      ["Only unacknowledged", unackedOnly ? "Yes" : "No"],
      ["Alarms listed", rows.length],
      ["Generated", ctx.epochToUtc(Date.now())],
    ];

    const sheets = [
      ctx.xlsx.sheet("Alarms", columns, rows, { tabColor: "C00000" }),
      ctx.xlsx.sheet("By Site", siteCols, siteRows, { tabColor: "1F4E78" }),
      ctx.xlsx.sheet("By Type", typeCols, typeRows, { tabColor: "1F4E78" }),
    ];
    if (failed.length) {
      sheets.push(ctx.xlsx.sheet("Failed Sites",
        [{ header: "Site", key: "site" }, { header: "Error", key: "error", wrap: true }],
        failed, { tabColor: "7F7F7F" }));
    }
    sheets.push(ctx.xlsx.sheet("Info", [{ header: "Field" }, { header: "Value" }], info,
      { autofilter: false, freeze: null }));

    const scopeName = allSites ? "all_sites" : ctx.safeName(targets[0].name);
    const failNote = failed.length ? `, ${failed.length} site(s) failed` : "";
    return {
      summary: allSites
        ? `${rows.length} alarm(s) at ${sitesWithAlarms} of ${targets.length} sites, ${rangeLabel}${failNote}`
        : `${rows.length} alarm(s) across ${byType.size} type(s) at ${targets[0].name}, ${rangeLabel}${failNote}`,
      filename: ctx.stampedName(`mist_alarms_${scopeName}_${duration}`, ctx.orgName, "xlsx"),
      sheets,
      preview: { title: `Alarms: ${scopeLabel} (${rangeLabel})`, columns, rows },
    };
  },
};
