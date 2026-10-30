// Ported from mist_switch_port_inventory.py.
//
// The fetch order and its fallbacks matter as much as the merge rules: the org
// endpoints answer for most tenants, and the per-site and per-device endpoints
// exist to fill the gaps left when they do not. Reproduced here:
//
//   1. inventory list + inventory search (VC members come from search)
//   2. per-site device lists, which often carry port_config inline
//   3. org port stats search, then per-site port stats only for sites whose
//      switches reported no ports
//   4. org device stats, then per-site device stats, then per-device stats for
//      switches still showing nothing
//
// The merge itself lives in lib/switchports.js.

import {
  PORT_COLUMNS, asSwitchRecord, buildPortRows, extractStatPorts, harvestPortConfig,
  isSecondaryVcMember, memberRecord, mergeSwitch, norm_mac, portCoverage, switchHasPorts,
} from "../lib/switchports.js";

const SITE_COLUMNS = ["Site", "Site ID", "Country", "Timezone", "Switches", "Ports", "Address"];
const SWITCH_COLUMNS = [
  "Site", "Switch Name", "MAC", "VC MAC", "Model", "Serial", "Status", "Firmware",
  "VC Role", "FPC / Member", "Site ID", "Device ID", "Ports In Export",
];
const PREVIEW_COLUMNS = [
  "Site", "Switch Name", "Port", "Port Status", "Speed/Duplex", "Port Usage / Profile",
  "Port Network / Native VLAN", "Neighbor System Name", "PoE Power Draw (W)",
];

const cols = (names) => names.map((n) => ({ header: n, key: n }));

export default {
  id: "port-inventory",
  name: "Switch Port Inventory",
  description: "Every physical switch port at one site or across an org on one sheet — 41 columns of live status, "
    + "speed, VLAN, PoE, LLDP neighbour and STP detail, merged with each port's configured "
    + "profile and attributed to the right virtual-chassis member.",
  tag: "Mist API",
  needs: { mistToken: true, org: true },
  scope: "site",
  params: [
    {
      id: "skipConfig",
      label: "Skip the per-switch port config fetch",
      type: "checkbox",
      default: false,
      hint: "Much faster on a large org, but loses port profile, mode, VLAN and PoE config columns.",
    },
  ],

  async run(ctx) {
    const { getAll, searchAll, mistGet, log, progress } = ctx;
    const org = ctx.orgId;

    // ---- Sites -------------------------------------------------------------
    const scope = await ctx.targetSites();
    const { sites } = scope;
    const inScope = (siteId) => scope.all || siteId === sites[0].id;
    log(`Scope: ${scope.label}.`, "info");

    // ---- Switches ----------------------------------------------------------
    const store = new Map();
    const embeddedConfigs = new Map();

    let listed = [];
    try {
      listed = await getAll(`/orgs/${org}/inventory`,
        { type: "switch", vc: true, unassigned: true });
    } catch (e) {
      log(`Inventory list failed (${e.message}).`, "err");
    }
    for (const raw of listed) if (raw && typeof raw === "object") mergeSwitch(store, asSwitchRecord(raw));
    log(`Inventory list: ${listed.length} record(s), ${store.size} unique MAC(s).`, "info");

    let searched = [];
    try {
      searched = await searchAll(`/orgs/${org}/inventory/search`, { type: "switch" });
    } catch (e) {
      log(`Inventory search failed (${e.message}).`, "err");
    }
    let memberRows = 0;
    for (const raw of searched) {
      if (!raw || typeof raw !== "object") continue;
      mergeSwitch(store, asSwitchRecord(raw));
      if (!Array.isArray(raw.members)) continue;
      raw.members.forEach((member, index) => {
        if (member && typeof member === "object" && member.mac) {
          mergeSwitch(store, memberRecord(raw, member, index));
          memberRows += 1;
        }
      });
    }
    log(`Inventory search: ${searched.length} row(s), ${memberRows} VC member(s) merged.`, "info");

    let siteDeviceCount = 0;
    let configsFromList = 0;
    let n = 0;
    for (const site of sites) {
      if (ctx.signal.aborted) break;
      n += 1;
      progress(n, sites.length, "site device lists");
      if (!site.id) continue;
      let devices = [];
      try {
        devices = await getAll(`/sites/${site.id}/devices`, { type: "switch" });
      } catch (e) {
        log(`Skip site devices ${site.name || site.id}: ${e.message}`, "err");
        continue;
      }
      for (const device of devices) {
        if (!device || typeof device !== "object") continue;
        const record = asSwitchRecord(device, site.id);
        mergeSwitch(store, record);
        siteDeviceCount += 1;
        const mac = norm_mac(record.mac);
        if (mac && harvestPortConfig(device, mac, embeddedConfigs)) configsFromList += 1;
      }
    }
    log(`Site device lists: ${siteDeviceCount} switch(es); port_config inline on ${configsFromList}.`, "info");

    // Inventory is fetched org-wide (it carries the VC member rows); a
    // single-site run keeps only that site's switches.
    const switches = [...store.values()].filter((sw) => scope.all || inScope(sw.site_id));
    if (!switches.length) {
      throw new Error(scope.all ? "No switches found in this org." : `No switches at ${scope.label}.`);
    }
    log(`${switches.length} unique switch(es); `
      + `${switches.filter((s) => s.site_id).length} assigned, `
      + `${switches.filter((s) => s.connected === true).length} connected, `
      + `${switches.filter(isSecondaryVcMember).length} VC member(s).`, "ok");

    // ---- Port stats --------------------------------------------------------
    let orgPorts = [];
    // For one site, the org-wide port search and device stats would pull the
    // whole org to keep a sliver; the per-site fallbacks below cover it.
    if (scope.all) try {
      orgPorts = await searchAll(`/orgs/${org}/stats/ports/search`, { device_type: "switch" },
        (done) => progress(done, done, "org port stats"));
      log(`Org port search: ${orgPorts.length} row(s).`, "info");
    } catch (e) {
      log(`Org port search unavailable (${e.message}); falling back to per-site.`, "info");
    }

    // ---- Device stats ------------------------------------------------------
    let switchStats = [];
    let orgStatsOk = false;
    if (scope.all) try {
      switchStats = await getAll(`/orgs/${org}/stats/devices`, { type: "switch", status: "all" });
      orgStatsOk = true;
      log(`Org device stats: ${switchStats.length} switch(es).`, "info");
    } catch (e) {
      log(`Org device stats unavailable (${e.message}); falling back to every site.`, "info");
    }

    const statsByMac = new Map();
    for (const item of switchStats) {
      const mac = norm_mac(item?.mac);
      if (mac) statsByMac.set(mac, item);
    }
    let added = 0;
    n = 0;
    for (const site of sites) {
      if (ctx.signal.aborted) break;
      n += 1;
      progress(n, sites.length, "site device stats");
      if (!site.id) continue;
      let batch = [];
      try {
        batch = await getAll(`/sites/${site.id}/stats/devices`, { type: "switch", status: "all" });
      } catch (e) {
        log(`Skip site stats ${site.name || site.id}: ${e.message}`, "err");
        continue;
      }
      for (const item of batch) {
        if (!item || typeof item !== "object") continue;
        if (item.site_id === undefined) item.site_id = site.id;
        const mac = norm_mac(item.mac);
        const current = mac ? statsByMac.get(mac) : null;
        if (current && orgStatsOk) {
          // Keep whichever source saw more ports for this switch.
          const sitePorts = extractStatPorts(item);
          if (sitePorts.length > extractStatPorts(current).length) current.ports = sitePorts;
          if (!current.site_id) current.site_id = site.id;
          continue;
        }
        switchStats.push(item);
        if (mac) statsByMac.set(mac, item);
        added += 1;
      }
    }
    log(`Device stats: ${switchStats.length} switch(es) (${added} from per-site).`, "info");

    // Per-site port stats, but only for sites whose switches reported nothing.
    const portMacs = new Set(orgPorts
      .filter((p) => p && typeof p === "object")
      .map((p) => norm_mac(p.mac || p.device_mac)));
    for (const st of switchStats) if (extractStatPorts(st).length) portMacs.add(norm_mac(st.mac));

    let missingSites = new Set(switches
      .filter((sw) => sw.site_id && !portMacs.has(norm_mac(sw.mac)) && !isSecondaryVcMember(sw))
      .map((sw) => sw.site_id));
    if (!orgPorts.length) missingSites = new Set(sites.filter((s) => s.id).map((s) => s.id));

    if (missingSites.size) {
      log(`${missingSites.size} site(s) still have switches with no port stats.`, "info");
      n = 0;
      for (const site of sites) {
        if (ctx.signal.aborted) break;
        if (!site.id || !missingSites.has(site.id)) continue;
        n += 1;
        progress(n, missingSites.size, "site port stats");
        try {
          const batch = await searchAll(`/sites/${site.id}/stats/ports/search`, { device_type: "switch" });
          for (const item of batch) {
            if (!item || typeof item !== "object") continue;
            if (item.site_id === undefined) item.site_id = site.id;
            orgPorts.push(item);
          }
        } catch (e) {
          log(`Skip site ports ${site.name || site.id}: ${e.message}`, "err");
        }
      }
      log(`Port rows after per-site fill: ${orgPorts.length}.`, "info");
    }

    // ---- Port config -------------------------------------------------------
    let portConfigs = new Map();
    if (ctx.params.skipConfig) {
      log("Skipping the per-switch port_config fetch.", "info");
    } else {
      portConfigs = new Map(embeddedConfigs);
      const haveMac = new Set([...portConfigs.keys()].map((k) => k.slice(0, k.indexOf("|"))));
      const need = switches.filter((sw) => {
        const mac = norm_mac(sw.mac);
        return mac && !haveMac.has(mac) && !isSecondaryVcMember(sw) && sw.site_id && sw.id;
      });
      let fetched = 0;
      n = 0;
      for (const sw of need) {
        if (ctx.signal.aborted) break;
        n += 1;
        progress(n, need.length, "port configs");
        try {
          const cfg = await mistGet(`/sites/${sw.site_id}/devices/${sw.id}`);
          fetched += 1;
          const mac = norm_mac(sw.mac);
          if (cfg && typeof cfg === "object" && harvestPortConfig(cfg, mac, portConfigs)) {
            haveMac.add(mac);
          }
        } catch {
          // A switch whose config will not load still gets its stats rows.
        }
      }
      log(`Port config from ${fetched} more switch(es); ${portConfigs.size} configured port entries.`, "info");
    }

    // Per-device stats for switches that still show no ports anywhere.
    const seeded = new Set(orgPorts
      .filter((p) => p && typeof p === "object")
      .map((p) => norm_mac(p.mac || p.device_mac)));
    for (const st of switchStats) if (extractStatPorts(st).length) seeded.add(norm_mac(st.mac));

    const needStats = switches.filter((sw) => {
      const mac = norm_mac(sw.mac);
      return mac && !seeded.has(mac) && !isSecondaryVcMember(sw) && sw.site_id && sw.id;
    });
    if (needStats.length) {
      log(`Filling ${needStats.length} switch(es) with no ports via per-device stats.`, "info");
      const known = new Set(switchStats.map((s) => norm_mac(s?.mac)).filter(Boolean));
      n = 0;
      for (const sw of needStats) {
        if (ctx.signal.aborted) break;
        n += 1;
        progress(n, needStats.length, "device stats");
        let item;
        try {
          item = await mistGet(`/sites/${sw.site_id}/stats/devices/${sw.id}`);
        } catch (e) {
          log(`No stats for ${sw.name || sw.mac}: ${e.message}`, "err");
          continue;
        }
        if (!item || typeof item !== "object") continue;
        if (item.site_id === undefined) item.site_id = sw.site_id;
        if (item.mac === undefined) item.mac = sw.mac;
        const mac = norm_mac(item.mac);
        if (mac && known.has(mac)) {
          const current = switchStats.find((s) => norm_mac(s?.mac) === mac);
          const ports = extractStatPorts(item);
          if (current && ports.length > extractStatPorts(current).length) current.ports = ports;
        } else {
          switchStats.push(item);
          if (mac) known.add(mac);
        }
      }
    }

    // ---- Build -------------------------------------------------------------
    const portRows = buildPortRows(sites, switches, orgPorts, switchStats, portConfigs);
    const { owners, vcs } = portCoverage(portRows);
    const quiet = switches.filter((sw) => !switchHasPorts(sw, owners, vcs));
    log(`${portRows.length} port row(s).`, "ok");
    if (quiet.length) {
      log(`${quiet.length} switch(es) produced no port rows — see Ports In Export on the `
        + "Switches sheet.", "info");
    }

    const portsPerSite = new Map();
    for (const r of portRows) {
      portsPerSite.set(r["Site ID"], (portsPerSite.get(r["Site ID"]) || 0) + 1);
    }
    const switchesPerSite = new Map();
    for (const sw of switches) {
      if (sw.site_id) switchesPerSite.set(sw.site_id, (switchesPerSite.get(sw.site_id) || 0) + 1);
    }

    const switchRows = switches.map((sw) => ({
      Site: sites.find((s) => s.id === sw.site_id)?.name || "",
      "Switch Name": sw.name || sw.hostname || "",
      MAC: norm_mac(sw.mac),
      "VC MAC": norm_mac(sw.vc_mac) === norm_mac(sw.mac) ? "" : norm_mac(sw.vc_mac),
      Model: sw.model || "",
      Serial: sw.serial || "",
      Status: sw.status || (sw.connected === true ? "connected"
        : sw.connected === false ? "disconnected" : ""),
      Firmware: sw.version || "",
      "VC Role": sw.vc_role || "",
      "FPC / Member": sw.member_id ?? "",
      "Site ID": sw.site_id || "",
      "Device ID": sw.id || "",
      "Ports In Export": switchHasPorts(sw, owners, vcs) ? "yes" : "no",
    })).sort((a, b) => String(a.Site).localeCompare(String(b.Site))
      || String(a["Switch Name"]).localeCompare(String(b["Switch Name"])));

    const siteRows = sites.map((s) => ({
      Site: s.name || "",
      "Site ID": s.id || "",
      Country: s.country_code || "",
      Timezone: s.timezone || "",
      Switches: switchesPerSite.get(s.id) || 0,
      Ports: portsPerSite.get(s.id) || 0,
      Address: s.address || "",
    })).sort((a, b) => String(a.Site).localeCompare(String(b.Site)));

    const summaryPairs = [
      ["Org", ctx.orgName],
      ["Org ID", org],
      ["Scope", scope.all ? "All sites" : `Site: ${scope.label}`],
      ["Mist API host", ctx.host],
      ["Generated", new Date().toLocaleString()],
      ["Sites", sites.length],
      ["Switches / VC members", switches.length],
      ["VC secondary members", switches.filter(isSecondaryVcMember).length],
      ["Switches connected", switches.filter((s) => s.connected === true).length],
      ["Switches with no port rows", quiet.length],
      ["Port rows", portRows.length],
      ["Ports up", portRows.filter((r) => r["Port Status"] === "up").length],
      ["Ports down", portRows.filter((r) => r["Port Status"] === "down").length],
      ["Ports admin disabled", portRows.filter((r) => r["Port Status"] === "disabled").length],
      ["Ports with PoE on", portRows.filter((r) => r["PoE On"] === "true").length],
      ["Ports with an LLDP neighbour", portRows.filter((r) => r["Neighbor System Name"]).length],
      ["Configured port entries", portConfigs.size],
    ];

    const { sheet } = ctx.xlsx;
    return {
      summary: `${portRows.length} ports across ${switches.length} switches and ${sites.length} sites`,
      filename: ctx.stampedName("mist_switch_ports", scope.fileLabel, "xlsx"),
      sheets: [
        sheet("Summary", cols(["Item", "Value"]),
          summaryPairs.map(([Item, Value]) => ({ Item, Value })),
          { autofilter: false, freeze: null, tabColor: "1F4E79" }),
        sheet("Switch Ports", cols(PORT_COLUMNS), portRows, { table: "SwitchPorts" }),
        sheet("Sites", cols(SITE_COLUMNS), siteRows),
        sheet("Switches", cols(SWITCH_COLUMNS), switchRows),
      ],
      preview: { title: "Switch ports", columns: cols(PREVIEW_COLUMNS), rows: portRows },
    };
  },
};
