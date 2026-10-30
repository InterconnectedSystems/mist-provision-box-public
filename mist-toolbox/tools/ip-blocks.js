// Ported from mist_ip_blocks.py (its internal name is mist_irb_report.py).
//
// Pulls the Mist-generated Junos config for every switch in an org, parses every
// `interfaces irb unit N` address plus the VLAN and routing-instance mappings
// that reference it, computes the subnet facts for each address, and sweeps for
// networks that appear at more than one site or overlap another block.
//
// The parsing lives in lib/junos.js and the address math in lib/subnet.js, both
// checked against their Python originals (shlex and ipaddress) in tests/.

import { FAMILY_LABEL, parseIrbConfig, unitSortKey } from "../lib/junos.js";
import { isLinkLocal, networkDetails, overlaps } from "../lib/subnet.js";
import { buildSwitchList, safeFilename } from "../lib/switchlist.js";

const INTERFACE_COLUMNS = [
  "Site", "Switch", "Switch MAC", "Model", "Interface", "VLAN Name", "VLAN ID",
  "Routing Instance", "Description", "Family", "Address Type", "Interface Address",
  "IP Address", "Prefix Length", "Subnet Mask", "Wildcard Mask", "Network",
  "Network Address", "Broadcast", "First Usable", "Last Usable", "Usable Hosts",
  "Virtual / VRRP Address", "Flags", "Notes", "Site ID", "Device ID",
];
const NETWORK_COLUMNS = [
  "Network", "Family", "Prefix Length", "Subnet Mask", "Usable Hosts", "Interface Count",
  "Switch Count", "Site Count", "Seen At Multiple Sites", "Overlaps With", "VLAN IDs",
  "VLAN Names", "Routing Instances", "Sites", "Switches", "Interface IPs",
];
const SWITCH_COLUMNS = [
  "Site", "Switch", "MAC", "Model", "Serial(s)", "VC Members", "Connected",
  "Config Status", "Config Lines", "IRB Units", "IRB Addresses", "Error", "Site ID", "Device ID",
];
const SITE_COLUMNS = ["Site", "Address", "Country", "Timezone", "Switches", "IRB Addresses", "Site ID"];

const PREVIEW_COLUMNS = [
  "Site", "Switch", "Interface", "VLAN ID", "Family", "Interface Address",
  "Network", "Usable Hosts", "Notes",
];

const cols = (names) => names.map((n) => ({ header: n, key: n }));

/** _maybe_int: a numeric VLAN id becomes a number so Excel sorts it as one. */
const maybeInt = (v) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v);

export { buildSwitchList, safeFilename };

/** irb_rows_for_switch */
export function irbRowsForSwitch(sw, parsed) {
  const l3ToVlan = {};
  for (const [name, v] of parsed.vlans) {
    if (v.l3_interface && !(v.l3_interface in l3ToVlan)) {
      l3ToVlan[v.l3_interface] = [name, v.vlan_id ?? ""];
    }
  }

  const rows = [];
  for (const unitNo of [...parsed.units.keys()].sort(unitSortKey)) {
    const unit = parsed.units.get(unitNo);
    const ifname = `irb.${unitNo}`;
    const [vlanName, vlanId] = l3ToVlan[ifname] || ["", ""];
    const base = {
      Site: sw.site_name,
      Switch: sw.name,
      "Switch MAC": sw.mac,
      Model: sw.model,
      Interface: ifname,
      "VLAN Name": vlanName,
      "VLAN ID": maybeInt(vlanId),
      "Routing Instance": parsed.routingInstances[ifname] || "",
      Description: unit.description,
      "Site ID": sw.site_id,
      "Device ID": sw.device_id,
    };
    const unitFlags = unit.disabled ? ["disabled"] : [];

    for (const addr of unit.addresses.values()) {
      const row = { ...base };
      row.Family = FAMILY_LABEL[addr.family] || addr.family;
      row["Address Type"] = "static";
      row["Interface Address"] = addr.address;
      const details = networkDetails(addr.address);
      const notes = [...(details._notes || [])];
      if (details.Notes) notes.push(details.Notes);
      for (const [k, v] of Object.entries(details)) {
        if (k !== "_notes" && k !== "Notes") row[k] = v;
      }
      row["Virtual / VRRP Address"] = addr.virtual.join(", ");
      row.Flags = [...unitFlags, ...addr.flags].join(", ");
      row.Notes = notes.join("; ");
      rows.push(row);
    }

    for (const [family, keyword] of unit.dhcp) {
      rows.push({
        ...base,
        Family: FAMILY_LABEL[family] || family,
        "Address Type": keyword,
        Flags: unitFlags.join(", "),
        Notes: "Address assigned dynamically; not in config",
      });
    }

    if (!unit.addresses.size && !unit.dhcp.length) {
      rows.push({
        ...base,
        "Address Type": "none",
        Flags: unitFlags.join(", "),
        Notes: "IRB unit has no address configured",
      });
    }
  }
  return rows;
}

/**
 * summarize_networks: aggregate per network, then find overlaps with a sweep
 * over networks sorted by start address, keeping only still-open blocks.
 * @returns {{rows: Array<object>, overlapCount: number}}
 */
export function summarizeNetworks(ifaceRows) {
  const nets = new Map();   // "10.0.0.0/24" -> aggregate
  for (const row of ifaceRows) {
    const net = row._network;
    if (!net) continue;
    const key = net.networkStr;
    let agg = nets.get(key);
    if (!agg) {
      agg = {
        net, addresses: [], switches: new Set(), sites: new Set(),
        vlanIds: new Set(), vlanNames: new Set(), ris: new Set(),
      };
      nets.set(key, agg);
    }
    agg.addresses.push(row["IP Address"]);
    agg.switches.add(`${row.Site}/${row.Switch}`);
    agg.sites.add(row.Site || row["Site ID"] || "");
    if (row["VLAN ID"] !== "" && row["VLAN ID"] !== null && row["VLAN ID"] !== undefined) {
      agg.vlanIds.add(String(row["VLAN ID"]));
    }
    if (row["VLAN Name"]) agg.vlanNames.add(row["VLAN Name"]);
    if (row["Routing Instance"]) agg.ris.add(row["Routing Instance"]);
  }

  const overlapsBy = new Map();   // key -> Set<key>
  const note = (a, b) => {
    if (!overlapsBy.has(a)) overlapsBy.set(a, new Set());
    overlapsBy.get(a).add(b);
  };

  for (const version of [4, 6]) {
    const ordered = [...nets.entries()]
      .filter(([, a]) => a.net.version === version
        && !isLinkLocal(a.net.version, a.net.networkAddress))
      .sort((x, y) => (x[1].net.networkAddress < y[1].net.networkAddress ? -1
        : x[1].net.networkAddress > y[1].net.networkAddress ? 1
          : x[1].net.prefixlen - y[1].net.prefixlen));

    let open = [];
    for (const [key, agg] of ordered) {
      const start = agg.net.networkAddress;
      open = open.filter(([, o]) => o.net.broadcastAddress >= start);
      for (const [otherKey, other] of open) {
        if (overlaps(agg.net, other.net)) { note(key, otherKey); note(otherKey, key); }
      }
      open.push([key, agg]);
    }
  }

  const sortedKeys = [...nets.entries()].sort((x, y) => x[1].net.version - y[1].net.version
    || (x[1].net.networkAddress < y[1].net.networkAddress ? -1
      : x[1].net.networkAddress > y[1].net.networkAddress ? 1
        : x[1].net.prefixlen - y[1].net.prefixlen)).map(([k]) => k);

  const rows = sortedKeys.map((key) => {
    const agg = nets.get(key);
    const details = networkDetails(key);
    const ov = [...(overlapsBy.get(key) || [])].sort((a, b) => {
      const na = nets.get(a).net;
      const nb = nets.get(b).net;
      return na.networkAddress < nb.networkAddress ? -1
        : na.networkAddress > nb.networkAddress ? 1 : na.prefixlen - nb.prefixlen;
    });
    return {
      Network: key,
      Family: `IPv${agg.net.version}`,
      "Prefix Length": agg.net.prefixlen,
      "Subnet Mask": details["Subnet Mask"] || "",
      "Usable Hosts": details["Usable Hosts"] ?? "",
      "Interface Count": agg.addresses.length,
      "Switch Count": agg.switches.size,
      "Site Count": agg.sites.size,
      "Seen At Multiple Sites": agg.sites.size > 1 ? "Yes" : "No",
      "Overlaps With": ov.slice(0, 25).join(", ") + (ov.length > 25 ? " ..." : ""),
      "VLAN IDs": [...agg.vlanIds].sort((a, b) => a.length - b.length || a.localeCompare(b)).join(", "),
      "VLAN Names": [...agg.vlanNames].sort().join(", "),
      "Routing Instances": [...agg.ris].sort().join(", "),
      Sites: [...agg.sites].sort().join(", "),
      Switches: [...agg.switches].sort().join(", "),
      "Interface IPs": agg.addresses.join(", "),
    };
  });

  return { rows, overlapCount: sortedKeys.filter((k) => overlapsBy.get(k)?.size).length };
}

export default {
  id: "ip-blocks",
  name: "IP Blocks / IRB Report",
  description: "Every IRB (switch VLAN) interface address at one site or across an org, with subnet, mask, "
    + "broadcast and usable range computed, plus duplicate and overlapping networks flagged "
    + "across sites.",
  tag: "Mist API",
  needs: { mistToken: true, org: true },
  scope: "site",
  params: [],

  async run(ctx) {
    const { getAll, mistGet, pool, POOL_LIMIT, log, progress } = ctx;

    const scope = await ctx.targetSites();
    const { sites } = scope;
    const sitesById = Object.fromEntries(scope.orgSites.map((s) => [s.id, s]));
    log(`Scope: ${scope.label}.`, "info");

    // One org inventory call either way; a single-site run keeps that site's switches.
    const inventory = await getAll(`/orgs/${ctx.orgId}/inventory`, { type: "switch", vc: true });
    const switches = buildSwitchList(inventory, sitesById)
      .filter((sw) => scope.all || sw.site_id === sites[0].id);
    const assigned = switches.filter((s) => s.site_id);
    for (const sw of switches) {
      if (!sw.site_id) sw.status = "Skipped - not assigned to a site";
    }
    log(`${inventory.length} inventory record(s) -> ${switches.length} switch(es) / VC, `
      + `${assigned.length} assigned to a site.`, "info");
    if (!assigned.length) {
      throw new Error(scope.all ? "No switches in this org are assigned to a site."
        : `No switches at ${scope.label}.`);
    }

    const ifaceRows = [];
    let done = 0;

    await pool(POOL_LIMIT, assigned.map((sw) => async () => {
      if (ctx.signal.aborted) return;
      try {
        const data = await mistGet(`/sites/${sw.site_id}/devices/${sw.device_id}/config_cmd`);
        let cli = data && typeof data === "object" && !Array.isArray(data) ? data.cli : data;
        if (typeof cli === "string") cli = cli.split(/\r?\n/);
        cli = cli || [];

        sw.cli_lines = cli.length;
        if (!cli.length) { sw.status = "No config returned"; return; }

        const parsed = parseIrbConfig(cli);
        const rows = irbRowsForSwitch(sw, parsed);
        ifaceRows.push(...rows);
        sw.irb_units = parsed.units.size;
        sw.addresses = rows.filter((r) => r["Address Type"] === "static").length;
        sw.status = sw.irb_units ? "OK" : "OK - no IRB interfaces";
      } catch (e) {
        sw.status = "Error";
        sw.error = e.message;
        log(`${sw.site_name || sw.site_id} / ${sw.name}: ${e.message}`, "err");
      } finally {
        done += 1;
        progress(done, assigned.length, "switches");
      }
    }));

    ifaceRows.sort((a, b) => String(a.Site).toLowerCase().localeCompare(String(b.Site).toLowerCase())
      || String(a.Switch).toLowerCase().localeCompare(String(b.Switch).toLowerCase())
      || unitSortKey(a.Interface.split(".")[1] || "", b.Interface.split(".")[1] || "")
      || String(a.Family || "").localeCompare(String(b.Family || "")));

    const { rows: netRows, overlapCount } = summarizeNetworks(ifaceRows);
    const staticRows = ifaceRows.filter((r) => r["Address Type"] === "static");

    log(`${staticRows.length} static IRB address(es), ${netRows.length} unique network(s), `
      + `${overlapCount} overlapping.`, "ok");

    const switchRows = switches.map((s) => ({
      Site: s.site_name, Switch: s.name, MAC: s.mac, Model: s.model,
      "Serial(s)": s.serials, "VC Members": s.members, Connected: s.connected ? "Yes" : "No",
      "Config Status": s.status, "Config Lines": s.cli_lines, "IRB Units": s.irb_units,
      "IRB Addresses": s.addresses, Error: s.error, "Site ID": s.site_id || "",
      "Device ID": s.device_id,
    }));

    const perSiteSwitches = {};
    const perSiteAddrs = {};
    for (const s of switches) {
      if (!s.site_id) continue;
      perSiteSwitches[s.site_id] = (perSiteSwitches[s.site_id] || 0) + 1;
      perSiteAddrs[s.site_id] = (perSiteAddrs[s.site_id] || 0) + s.addresses;
    }
    const siteRows = sites.map((s) => ({
      Site: s.name || "", Address: s.address || "", Country: s.country_code || "",
      Timezone: s.timezone || "", Switches: perSiteSwitches[s.id] || 0,
      "IRB Addresses": perSiteAddrs[s.id] || 0, "Site ID": s.id || "",
    })).sort((a, b) => String(a.Site).toLowerCase().localeCompare(String(b.Site).toLowerCase()));

    const summaryPairs = [
      ["Org", ctx.orgName],
      ["Org ID", ctx.orgId],
      ["Scope", scope.all ? "All sites" : `Site: ${scope.label}`],
      ["Mist API host", ctx.host],
      ["Generated", new Date().toLocaleString()],
      ["Sites", sites.length],
      ["Switches / VCs", switches.length],
      ["Switches with config pulled", switches.filter((s) => s.status.startsWith("OK")).length],
      ["Switches with errors", switches.filter((s) => s.status === "Error").length],
      ["Switches not assigned to a site", switches.filter((s) => !s.site_id).length],
      ["IRB units", switches.reduce((n, s) => n + s.irb_units, 0)],
      ["IRB static addresses", staticRows.length],
      ["IPv4 addresses", staticRows.filter((r) => r.Family === "IPv4").length],
      ["IPv6 addresses", staticRows.filter((r) => r.Family === "IPv6").length],
      ["Unique networks", netRows.length],
      ["Networks seen at multiple sites", netRows.filter((r) => r["Seen At Multiple Sites"] === "Yes").length],
      ["Networks overlapping another network", overlapCount],
    ];

    const { sheet } = ctx.xlsx;
    return {
      summary: `${staticRows.length} IRB addresses, ${netRows.length} networks, `
        + `${overlapCount} overlapping, ${netRows.filter((r) => r["Seen At Multiple Sites"] === "Yes").length} at multiple sites`,
      filename: ctx.stampedName("mist_irb", scope.fileLabel, "xlsx"),
      sheets: [
        sheet("Summary", cols(["Item", "Value"]),
          summaryPairs.map(([Item, Value]) => ({ Item, Value })),
          { autofilter: false, freeze: null, tabColor: "1F4E79" }),
        sheet("IRB Interfaces", cols(INTERFACE_COLUMNS), ifaceRows),
        sheet("Networks", cols(NETWORK_COLUMNS), netRows),
        sheet("Switches", cols(SWITCH_COLUMNS), switchRows),
        sheet("Sites", cols(SITE_COLUMNS), siteRows),
      ],
      preview: { title: "IRB interfaces", columns: cols(PREVIEW_COLUMNS), rows: ifaceRows },
    };
  },
};
