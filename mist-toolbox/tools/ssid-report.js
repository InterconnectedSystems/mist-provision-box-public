// Ported from mist_ssid_report.py.
//
// The useful trick in the original is /sites/{id}/wlans/derived, which asks Mist
// what actually applies at a site — site-level SSIDs plus everything pushed down
// from org WLAN templates — instead of making the caller resolve template
// inheritance. The row shaping below is describe_auth / describe_vlan /
// wlan_source / wlan_row translated directly.
//
// The Python hardcoded api.gc2.mist.com; the region comes from the shell here.

export default {
  id: "ssid-report",
  name: "SSID Report",
  description: "Every SSID that applies at one site or at every site in an org, including ones pushed down from "
    + "org-level WLAN templates, with auth type, VLAN, bands and which template it came from.",
  tag: "Mist API",
  needs: { mistToken: true, org: true },
  scope: "site",
  params: [
    {
      id: "skipEmpty",
      label: "Omit sites with no SSIDs",
      type: "checkbox",
      default: false,
      hint: "Sites still appear on the Site Summary sheet either way.",
    },
  ],

  async run(ctx) {
    const { getAll, pool, POOL_LIMIT, log, progress } = ctx;

    log(`Org: ${ctx.orgName}`, "info");

    // template_id -> template name, to label where an SSID comes from.
    let templates = {};
    try {
      const list = await getAll(`/orgs/${ctx.orgId}/templates`);
      templates = Object.fromEntries(list.map((t) => [t.id, t.name || t.id]));
      log(`${list.length} WLAN template(s).`, "info");
    } catch {
      // get_wlan_templates swallowed an HTTPError here too: a token without
      // template read access should still get the report.
      log("Could not read WLAN templates — SSID sources will show the raw ID.", "info");
    }

    const scope = await ctx.targetSites();
    const { sites } = scope;
    log(`Scope: ${scope.label}.`, "info");

    const errors = [];
    let done = 0;
    const perSite = await pool(POOL_LIMIT, sites.map((site) => async () => {
      if (ctx.signal.aborted) return { site, wlans: [] };
      try {
        const wlans = await getAll(`/sites/${site.id}/wlans/derived`);
        return { site, wlans: Array.isArray(wlans) ? wlans : [] };
      } catch (e) {
        errors.push([site.name || site.id, e.message]);
        return { site, wlans: [] };
      } finally {
        done += 1;
        progress(done, sites.length, "sites");
      }
    }));

    const detail = [];
    const summary = [];
    for (const { site, wlans } of perSite) {
      const enabled = wlans.filter((w) => w.enabled !== false).length;
      summary.push({
        site: site.name || "",
        siteId: site.id || "",
        count: wlans.length,
        enabled,
        disabled: wlans.length - enabled,
      });
      if (ctx.params.skipEmpty && !wlans.length) continue;
      for (const w of wlans) detail.push(row(site, w, templates));
    }

    detail.sort((a, b) => (a.site || "").localeCompare(b.site || "")
      || (a.ssid || "").localeCompare(b.ssid || ""));
    summary.sort((a, b) => (a.site || "").localeCompare(b.site || ""));

    if (errors.length) log(`${errors.length} site(s) could not be read — see the Info sheet.`, "err");
    log(`${detail.length} SSID rows across ${sites.length} sites.`, "ok");

    const { sheet } = ctx.xlsx;
    const detailCols = [
      { header: "Site", key: "site" },
      { header: "Site ID", key: "siteId" },
      { header: "SSID", key: "ssid" },
      { header: "Enabled", key: "enabled" },
      { header: "Hidden", key: "hidden" },
      { header: "Auth", key: "auth" },
      { header: "VLAN", key: "vlan" },
      { header: "Bands", key: "bands" },
      { header: "Interface", key: "iface" },
      { header: "Source", key: "source" },
      { header: "WLAN ID", key: "wlanId" },
    ];

    const info = [
      ["Org", ctx.orgName],
      ["Org ID", ctx.orgId],
      ["Scope", scope.all ? "All sites" : `Site: ${scope.label}`],
      ["Cloud", `https://${ctx.host}/api/v1`],
      ["Generated", new Date().toLocaleString()],
      ["Sites", sites.length],
      ["SSID rows", detail.length],
    ];
    if (errors.length) {
      info.push([], ["Sites with errors"], ...errors);
    }

    return {
      summary: `${detail.length} SSID rows across ${sites.length} sites`
        + (errors.length ? `, ${errors.length} site(s) unreadable` : ""),
      filename: ctx.stampedName("mist_ssids", scope.fileLabel, "xlsx"),
      sheets: [
        sheet("SSIDs by Site", detailCols, detail, { tabColor: "1F4E79" }),
        sheet("Site Summary", [
          { header: "Site", key: "site" },
          { header: "Site ID", key: "siteId" },
          { header: "SSID Count", key: "count" },
          { header: "Enabled SSIDs", key: "enabled" },
          { header: "Disabled SSIDs", key: "disabled" },
        ], summary),
        sheet("Info", [
          { header: "Field", width: 20 },
          { header: "Value", width: 60 },
        ], info, { autofilter: false, freeze: null }),
      ],
      preview: { title: "SSIDs by Site", columns: detailCols, rows: detail },
    };
  },
};

/** describe_vlan */
export function describeVlan(wlan) {
  if (!wlan.vlan_enabled) return "untagged";
  if (wlan.vlan_ids && wlan.vlan_ids.length) return wlan.vlan_ids.map(String).join(",");
  return String(wlan.vlan_id ?? "") || "dynamic";
}

/** describe_auth */
export function describeAuth(wlan) {
  const auth = wlan.auth || {};
  const type = auth.type || "";
  const pairwise = auth.pairwise || [];
  return pairwise.length ? `${type} (${pairwise.join("/")})` : type;
}

/** wlan_source */
export function wlanSource(wlan, templates) {
  if (wlan.template_id) return `Org template: ${templates[wlan.template_id] || wlan.template_id}`;
  if (wlan.site_id) return "Site";
  return "Org";
}

/** wlan_row */
function row(site, wlan, templates) {
  const bands = wlan.bands || (wlan.band ? [wlan.band] : []);
  return {
    site: site.name || "",
    siteId: site.id || "",
    ssid: wlan.ssid || "",
    enabled: wlan.enabled === false ? "No" : "Yes",
    hidden: wlan.hide_ssid ? "Yes" : "No",
    auth: describeAuth(wlan),
    vlan: describeVlan(wlan),
    bands: bands.map(String).join(", "),
    iface: wlan.interface || "",
    source: wlanSource(wlan, templates),
    wlanId: wlan.id || "",
  };
}
