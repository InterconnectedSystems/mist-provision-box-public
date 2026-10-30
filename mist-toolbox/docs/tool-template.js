// A complete, working Mist Provision Box tool to copy from.
//
// It counts the devices at one site, or at every site, from one org inventory
// call. `scope: "site"` gives it the site picker and the "All sites in the
// org" box; ctx.targetSites() says which sites were chosen. Rename the
// file (e.g. my-report.js), change id / name / description, replace run(), and
// install it with the toolbox's "Manage tools" button.
//
// It only reads, which is best practice. For a tool that makes changes to Mist,
// start from tool-template-writes.js instead.

export default {
  id: "device-count",
  name: "Device Count by Site",
  description: "How many access points, switches and gateways one site, or every site "
    + "in the org, has — from the org inventory, with a total row.",
  tag: "Mist API",
  needs: { mistToken: true, org: true },
  scope: "site",
  params: [
    {
      id: "connectedOnly",
      label: "Count connected devices only",
      type: "checkbox",
      default: false,
    },
  ],

  async run(ctx) {
    const { getAll, log } = ctx;
    log(`Org: ${ctx.orgName}`, "info");

    const scope = await ctx.targetSites();
    const siteName = Object.fromEntries(scope.orgSites.map((s) => [s.id, s.name || s.id]));
    const wanted = new Set(scope.sites.map((s) => s.id));
    log(`Scope: ${scope.label}`, "info");

    // The inventory call is org-wide; keep the chosen sites (and, for the
    // whole org, devices not yet assigned to any site).
    const inventory = (await getAll(`/orgs/${ctx.orgId}/inventory`))
      .filter((d) => wanted.has(d.site_id) || (scope.all && !d.site_id));
    const counted = ctx.params.connectedOnly ? inventory.filter((d) => d.connected) : inventory;
    log(`${counted.length} device(s) counted of ${inventory.length} in inventory.`, "info");

    const bySite = new Map();
    for (const d of counted) {
      const key = d.site_id || "";
      const row = bySite.get(key) || { site: siteName[key] || "(unassigned)", ap: 0, switch: 0, gateway: 0 };
      if (d.type in row) row[d.type] += 1;
      bySite.set(key, row);
    }
    const rows = [...bySite.values()].sort((a, b) => a.site.localeCompare(b.site));
    rows.push({
      site: "Total",
      ap: rows.reduce((n, r) => n + r.ap, 0),
      switch: rows.reduce((n, r) => n + r.switch, 0),
      gateway: rows.reduce((n, r) => n + r.gateway, 0),
      __style: "bold",
    });

    const columns = [
      { header: "Site", key: "site" },
      { header: "Access Points", key: "ap" },
      { header: "Switches", key: "switch" },
      { header: "Gateways", key: "gateway" },
    ];

    log("Done.", "ok");
    return {
      summary: `${counted.length} device(s) across ${rows.length - 1} site(s)`,
      filename: ctx.stampedName("mist_device_count", scope.fileLabel, "xlsx"),
      sheets: [ctx.xlsx.sheet("Devices by Site", columns, rows)],
      preview: { title: "Devices by Site", columns, rows },
    };
  },
};
