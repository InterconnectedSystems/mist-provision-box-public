// Switch Additional CLI: collects every "additional CLI commands" block that
// applies to switches, for every site in the org or one chosen site.
// Levels read:
//   Template      GET /orgs/{org_id}/networktemplates   (template + its switch rules)
//   Site          GET /sites/{site_id}/setting           (site + its switch rules)
//   Device        GET /sites/{site_id}/devices?type=switch
// Mist field: additional_config_cmds (array of strings, one command per entry).

const CELL_MAX = 32000; // Excel cell limit is 32,767 characters

const list = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
const cmds = (obj) => list(obj?.additional_config_cmds).map((c) => String(c).trim()).filter(Boolean);
const clip = (s) => (s.length > CELL_MAX ? s.slice(0, CELL_MAX) + "\n…(truncated)" : s);
const rules = (obj) => list(obj?.switch_matching?.rules);

export default {
  id: "switch-additional-cli",
  name: "Switch Additional CLI",
  description:
    "Gathers the additional CLI commands applied to switches at template, site and " +
    "device level, for every site in the org or one site, laid out for side-by-side comparison.",
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
  ],

  async run(ctx) {
    const { allSites, siteId } = ctx.params;

    // Full site records, not ctx.listSites(): that trims each site to {id, name}
    // and drops networktemplate_id, which the template level needs.
    const sites = (await ctx.getAll(`/orgs/${ctx.orgId}/sites`))
      .filter((s) => typeof s.id === "string")
      .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
    let targets;
    if (allSites) {
      targets = sites;
      if (!targets.length) throw new Error("This org has no sites.");
    } else {
      if (!siteId) throw new Error("Pick a site, or tick \"All sites in the org\".");
      const s = sites.find((x) => x.id === siteId);
      targets = [s || { id: siteId, name: siteId }];
    }
    const siteName = (s) => s.name || s.id;
    const scopeLabel = allSites ? `all ${targets.length} sites` : siteName(targets[0]);

    // Templates: org level, read once.
    ctx.status("Loading switch templates…");
    let templates = [];
    try {
      templates = await ctx.getAll(`/orgs/${ctx.orgId}/networktemplates`);
    } catch (e) {
      ctx.log(`Switch templates unavailable (${e.message})`, "err");
    }
    const tplById = Object.fromEntries(templates.map((t) => [t.id, t]));

    // Sites: setting + switches, in parallel. One failing site is logged and skipped.
    ctx.status(`Loading additional CLI for ${scopeLabel}…`);
    let done = 0;
    const failed = [];
    const perSite = await ctx.pool(
      ctx.POOL_LIMIT,
      targets.map((site) => async () => {
        if (ctx.signal.aborted) return null;
        try {
          const [setting, devices] = await Promise.all([
            ctx.mistGet(`/sites/${site.id}/setting`),
            ctx.getAll(`/sites/${site.id}/devices`, { type: "switch" }),
          ]);
          return { site, setting, switches: devices.filter((d) => !d.type || d.type === "switch") };
        } catch (e) {
          failed.push({ site: siteName(site), error: e.message });
          ctx.log(`${siteName(site)}: ${e.message}`, "err");
          return null;
        } finally {
          ctx.progress(++done, targets.length, siteName(site));
        }
      }),
    );
    if (ctx.signal.aborted) throw new Error("Cancelled.");
    const results = perSite.filter(Boolean);

    // ---- Build rows -------------------------------------------------------
    const lineRows = [];      // one row per command
    const switchRows = [];    // one row per switch
    const siteRows = [];      // one row per site
    const unique = new Map(); // command -> { levels, sites, switches }
    const textOut = [];       // combined .txt

    const addLines = (base, list) =>
      list.forEach((command, i) => lineRows.push({ ...base, line: i + 1, command }));
    const track = (command, level, site, sw) => {
      const u = unique.get(command) || { command, levels: new Set(), sites: new Set(), switches: new Set() };
      u.levels.add(level);
      if (site) u.sites.add(site);
      if (sw) u.switches.add(sw);
      unique.set(command, u);
    };

    // Template level: listed once per template, and credited to every site that uses it.
    const tplSites = new Map(); // template id -> [site names in scope]
    for (const { site } of results) {
      const id = site.networktemplate_id;
      if (id) tplSites.set(id, [...(tplSites.get(id) || []), siteName(site)]);
    }
    const templateRows = [];
    for (const [id, usedBy] of tplSites) {
      const t = tplById[id];
      const tName = t?.name || id;
      const blocks = t ? [{ rule: "", list: cmds(t) }, ...rules(t).map((r) => ({ rule: r.name || "(unnamed rule)", list: cmds(r) }))] : [];
      for (const b of blocks.filter((b) => b.list.length)) {
        const level = b.rule ? "Template rule" : "Template";
        templateRows.push({
          template: tName, rule: b.rule, lines: b.list.length,
          sites: usedBy.length, cli: clip(b.list.join("\n")),
        });
        addLines({ site: "", level, source: tName, rule: b.rule, switch: "" }, b.list);
        for (const c of b.list) for (const s of usedBy) track(c, level, s, "");
      }
    }

    for (const { site, setting, switches } of results.sort((a, b) => siteName(a.site).localeCompare(siteName(b.site)))) {
      const sName = siteName(site);
      const tpl = tplById[site.networktemplate_id];
      const tName = tpl?.name || site.networktemplate_id || "";
      const tplCount = tpl ? cmds(tpl).length + rules(tpl).reduce((n, r) => n + cmds(r).length, 0) : 0;

      textOut.push(`${"=".repeat(78)}\nSITE: ${sName}${tName ? `   (template: ${tName})` : ""}\n${"=".repeat(78)}`);

      // Site level
      const siteCmds = cmds(setting);
      addLines({ site: sName, level: "Site", source: sName, rule: "", switch: "" }, siteCmds);
      siteCmds.forEach((c) => track(c, "Site", sName, ""));
      if (siteCmds.length) textOut.push(`--- Site additional CLI ---\n${siteCmds.join("\n")}`);

      let siteRuleCount = 0;
      for (const r of rules(setting)) {
        const rc = cmds(r);
        if (!rc.length) continue;
        siteRuleCount += rc.length;
        const rName = r.name || "(unnamed rule)";
        addLines({ site: sName, level: "Site rule", source: sName, rule: rName, switch: "" }, rc);
        rc.forEach((c) => track(c, "Site rule", sName, ""));
        textOut.push(`--- Site switch rule: ${rName} ---\n${rc.join("\n")}`);
      }

      // Device level
      let devCount = 0;
      let swWithCli = 0;
      for (const sw of switches.sort((a, b) => String(a.name || a.mac).localeCompare(String(b.name || b.mac)))) {
        const swName = sw.name || ctx.fmtMac(String(sw.mac || "")) || sw.id;
        const dc = cmds(sw);
        devCount += dc.length;
        if (dc.length) swWithCli += 1;
        addLines({ site: sName, level: "Device", source: swName, rule: "", switch: swName }, dc);
        dc.forEach((c) => track(c, "Device", sName, `${sName} / ${swName}`));
        if (dc.length) textOut.push(`--- Switch: ${swName} (${sw.model || "?"}) ---\n${dc.join("\n")}`);
        switchRows.push({
          site: sName, switch: swName, model: sw.model || "",
          mac: sw.mac ? ctx.fmtMac(String(sw.mac)) : "", template: tName,
          tplLines: tplCount, siteLines: siteCmds.length + siteRuleCount, devLines: dc.length,
          cli: clip(dc.join("\n")),
          __style: dc.length ? "yellow" : undefined,
        });
      }
      if (!siteCmds.length && !siteRuleCount && !devCount) textOut.push("(no site or device additional CLI)");
      textOut.push("");

      siteRows.push({
        site: sName, template: tName, switches: switches.length,
        tplLines: tplCount, siteLines: siteCmds.length, siteRuleLines: siteRuleCount,
        swWithCli, devLines: devCount,
        siteCli: clip(siteCmds.join("\n")),
      });
    }

    const uniqueRows = [...unique.values()]
      .map((u) => ({
        command: u.command,
        levels: [...u.levels].join(", "),
        siteCount: u.sites.size,
        switchCount: u.switches.size,
        sites: clip([...u.sites].sort().join(", ")),
      }))
      .sort((a, b) => b.siteCount - a.siteCount || a.command.localeCompare(b.command));

    // ---- Sheets -----------------------------------------------------------
    const siteCols = [
      { header: "Site", key: "site", width: 30 },
      { header: "Switch Template", key: "template", width: 24 },
      { header: "Switches", key: "switches", width: 10 },
      { header: "Template CLI Lines", key: "tplLines", width: 12 },
      { header: "Site CLI Lines", key: "siteLines", width: 12 },
      { header: "Site Rule CLI Lines", key: "siteRuleLines", width: 12 },
      { header: "Switches w/ Device CLI", key: "swWithCli", width: 12 },
      { header: "Device CLI Lines", key: "devLines", width: 12 },
      { header: "Site Additional CLI", key: "siteCli", width: 70, wrap: true },
    ];
    const switchCols = [
      { header: "Site", key: "site", width: 30 },
      { header: "Switch", key: "switch", width: 26 },
      { header: "Model", key: "model", width: 14 },
      { header: "MAC", key: "mac", width: 18 },
      { header: "Switch Template", key: "template", width: 24 },
      { header: "Template CLI Lines", key: "tplLines", width: 12 },
      { header: "Site CLI Lines", key: "siteLines", width: 12 },
      { header: "Device CLI Lines", key: "devLines", width: 12 },
      { header: "Device Additional CLI", key: "cli", width: 70, wrap: true },
    ];
    const lineCols = [
      { header: "Site", key: "site", width: 30 },
      { header: "Level", key: "level", width: 14 },
      { header: "Source", key: "source", width: 26 },
      { header: "Switch Rule", key: "rule", width: 20 },
      { header: "Switch", key: "switch", width: 26 },
      { header: "Line #", key: "line", width: 8 },
      { header: "Command", key: "command", width: 90 },
    ];
    const uniqueCols = [
      { header: "Command", key: "command", width: 80 },
      { header: "Levels", key: "levels", width: 22 },
      { header: "Sites", key: "siteCount", width: 8 },
      { header: "Switches (device level)", key: "switchCount", width: 12 },
      { header: "Site Names", key: "sites", width: 60, wrap: true },
    ];
    const templateCols = [
      { header: "Template", key: "template", width: 26 },
      { header: "Switch Rule", key: "rule", width: 22 },
      { header: "Lines", key: "lines", width: 8 },
      { header: "Sites Using (in scope)", key: "sites", width: 12 },
      { header: "Additional CLI", key: "cli", width: 80, wrap: true },
    ];

    const totalSwitches = switchRows.length;
    const info = [
      ["Org", ctx.orgName],
      ["Scope", allSites ? "All sites" : siteName(targets[0])],
      ["Sites queried", targets.length],
      ["Sites that failed", failed.length],
      ["Switches found", totalSwitches],
      ["Switches with device-level CLI", switchRows.filter((r) => r.devLines).length],
      ["Command lines (all levels)", lineRows.length],
      ["Distinct commands", uniqueRows.length],
      ["Note", "Template and site switch-rule commands apply only to switches that match the rule; " +
        "this report does not work out which switches each rule matches."],
      ["Generated", ctx.epochToUtc(Date.now())],
    ];

    const sheets = [
      ctx.xlsx.sheet("By Site", siteCols, siteRows, { tabColor: "1F4E78" }),
      ctx.xlsx.sheet("By Switch", switchCols, switchRows, { tabColor: "1F4E78" }),
      ctx.xlsx.sheet("CLI Lines", lineCols, lineRows, { tabColor: "C55A11" }),
      ctx.xlsx.sheet("Unique Commands", uniqueCols, uniqueRows, { tabColor: "548235" }),
      ctx.xlsx.sheet("Templates", templateCols, templateRows, { tabColor: "7030A0" }),
    ];
    if (failed.length) {
      sheets.push(ctx.xlsx.sheet("Failed Sites",
        [{ header: "Site", key: "site" }, { header: "Error", key: "error", wrap: true }],
        failed, { tabColor: "7F7F7F" }));
    }
    sheets.push(ctx.xlsx.sheet("Info", [{ header: "Field" }, { header: "Value", wrap: true }], info,
      { autofilter: false, freeze: null }));

    // Plain-text copy, grouped by site, for grep/diff.
    const tplText = templateRows.map((t) =>
      `--- Template: ${t.template}${t.rule ? ` / rule: ${t.rule}` : ""} ---\n${t.cli}`);
    const txt = [
      `Mist switch additional CLI — ${ctx.orgName} — ${scopeLabel} — ${ctx.epochToUtc(Date.now())}`,
      "",
      ...(tplText.length ? [`${"#".repeat(78)}\nTEMPLATES\n${"#".repeat(78)}`, ...tplText, ""] : []),
      ...textOut,
    ].join("\n");
    const scopeName = allSites ? "all_sites" : ctx.safeName(siteName(targets[0]));
    const txtName = ctx.stampedName(`mist_switch_cli_${scopeName}`, ctx.orgName, "txt");

    const failNote = failed.length ? `, ${failed.length} site(s) failed` : "";
    return {
      summary: `${lineRows.length} command line(s), ${uniqueRows.length} distinct, across ` +
        `${results.length} site(s) and ${totalSwitches} switch(es)${failNote}`,
      filename: ctx.stampedName(`mist_switch_cli_${scopeName}`, ctx.orgName, "xlsx"),
      sheets,
      preview: { title: `Additional CLI lines: ${scopeLabel}`, columns: lineCols, rows: lineRows },
      files: [{ name: txtName, blob: new Blob([txt], { type: "text/plain" }) }],
    };
  },
};
