// Switch Config Export: each switch's configuration as Mist renders it
// (`set` commands from /devices/{id}/config_cmd), one .txt per switch.
//
// This was the "--save-configs" option of mist_ip_blocks.py, then a checkbox
// on the IP Blocks report; it is its own job, so it is its own tool. One
// switch downloads as a plain .txt; more than one comes as a single .zip with
// a folder per site and an index.csv, so a large org does not trip the
// browser's "allow multiple downloads" prompt.

import { zip } from "../lib/zip.js";
import { buildSwitchList, safeFilename } from "../lib/switchlist.js";

/** Per-switch download buttons beyond this many would bury the result screen. */
const MAX_BUTTONS = 25;

export default {
  id: "switch-configs",
  name: "Switch Config Export",
  description: "Downloads the running configuration of every switch at one site or across an "
    + "org, as Junos set commands — a .txt for one switch, or a .zip with a folder per site.",
  tag: "Mist API",
  needs: { mistToken: true, org: true },
  scope: "site",
  params: [],

  async run(ctx) {
    const { getAll, mistGet, pool, POOL_LIMIT, log, progress } = ctx;

    const scope = await ctx.targetSites();
    const { sites } = scope;
    const sitesById = Object.fromEntries(scope.orgSites.map((s) => [s.id, s]));
    const wanted = new Set(sites.map((s) => s.id));
    log(`Scope: ${scope.label}.`, "info");

    // A virtual chassis has one config, so members collapse onto the VC.
    const inventory = await getAll(`/orgs/${ctx.orgId}/inventory`, { type: "switch", vc: true });
    const switches = buildSwitchList(inventory, sitesById).filter((sw) => sw.site_id && wanted.has(sw.site_id));
    if (!switches.length) {
      throw new Error(scope.all ? "No switches in this org are assigned to a site." : `No switches at ${scope.label}.`);
    }
    log(`${switches.length} switch(es) / VC to export.`, "info");

    let done = 0;
    const exported = await pool(POOL_LIMIT, switches.map((sw) => async () => {
      if (ctx.signal.aborted) return null;
      try {
        const data = await mistGet(`/sites/${sw.site_id}/devices/${sw.device_id}/config_cmd`);
        let cli = data && typeof data === "object" && !Array.isArray(data) ? data.cli : data;
        if (typeof cli === "string") cli = cli.split(/\r?\n/);
        cli = Array.isArray(cli) ? cli.map(String) : [];
        sw.cli_lines = cli.length;
        sw.status = cli.length ? "Exported" : "No config returned";
        return cli.length ? { sw, text: `${cli.join("\n")}\n` } : null;
      } catch (e) {
        sw.status = "Error";
        sw.error = e.message;
        log(`${sw.site_name || sw.site_id} / ${sw.name}: ${e.message}`, "err");
        return null;
      } finally {
        done += 1;
        progress(done, switches.length, "switches");
      }
    }));
    const files = exported.filter(Boolean);
    const failed = switches.filter((sw) => sw.status === "Error").length;
    if (!files.length) throw new Error("No switch returned a configuration.");

    const txtName = (sw) => `${safeFilename(`${sw.site_name}__${sw.name}__${sw.mac}`)}.txt`;
    const txtBlob = (text) => new Blob([text], { type: "text/plain" });

    let main;
    if (files.length === 1) {
      main = { name: txtName(files[0].sw), blob: txtBlob(files[0].text) };
    } else {
      const index = ctx.toCsv(
        ["Site", "Switch", "MAC", "Model", "Serials", "VC Members", "Config Lines", "Status", "Error", "File"],
        switches.map((sw) => [sw.site_name, sw.name, sw.mac, sw.model, sw.serials, sw.members,
          sw.cli_lines, sw.status, sw.error,
          sw.status === "Exported" ? `${safeFilename(sw.site_name)}/${txtName(sw)}` : ""]),
      );
      const blob = await zip([
        { name: "index.csv", data: index },
        ...files.map(({ sw, text }) => ({ name: `${safeFilename(sw.site_name)}/${txtName(sw)}`, data: text })),
      ]);
      main = { name: ctx.stampedName("mist_switch_configs", scope.fileLabel, "zip"), blob };
    }
    ctx.download(main.blob, main.name);
    log(`Saved ${main.name} to your downloads.`, "ok");

    const extra = files.length > 1 && files.length <= MAX_BUTTONS
      ? files.map(({ sw, text }) => ({ name: txtName(sw), blob: txtBlob(text) }))
      : [];

    const columns = [
      { header: "Site", key: "site_name" },
      { header: "Switch", key: "name" },
      { header: "MAC", key: "mac" },
      { header: "Model", key: "model" },
      { header: "Config Lines", key: "cli_lines" },
      { header: "Status", key: "status" },
      { header: "Error", key: "error" },
    ];
    return {
      summary: `${files.length} of ${switches.length} switch config(s) exported from ${scope.label}`
        + (failed ? `, ${failed} failed` : "") + ` — ${main.name}`,
      files: [main, ...extra],
      preview: { title: "Switches", columns, rows: switches },
    };
  },
};
