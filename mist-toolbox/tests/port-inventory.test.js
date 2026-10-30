// The port inventory's merge rules, ported from mist_switch_port_inventory.py's
// _self_test() plus the cases that test covered only implicitly.

import { strict as assert } from "node:assert";
import test from "node:test";

import {
  PORT_COLUMNS, asSwitchRecord, buildPortRows, expandPortKey, extractStatPorts, first,
  fmtSpeedDuplex, fpcFromPort, harvestPortConfig, indexSwitches, isSecondaryVcMember,
  memberRecord, mergeSwitch, norm_mac, norm_port, portCoverage, portStatus, switchHasPorts,
} from "../lib/switchports.js";
import tool from "../tools/port-inventory.js";
import { sheetNamed, stubMist, testCtx } from "./helpers.mjs";

test("norm_mac and norm_port strip to a comparable form", () => {
  assert.equal(norm_mac("AA:BB:CC:00:11:22"), "aabbcc001122");
  assert.equal(norm_mac("aabbcc001122"), "aabbcc001122");
  assert.equal(norm_mac(null), "");
  assert.equal(norm_port("  GE-0/0/1 "), "ge-0/0/1");
});

test("expandPortKey expands ranges, lists and keeps zero padding", () => {
  assert.deepEqual(expandPortKey("ge-0/0/0-3"),
    ["ge-0/0/0", "ge-0/0/1", "ge-0/0/2", "ge-0/0/3"]);
  assert.deepEqual(expandPortKey("ge-0/0/0-ge-0/0/2"),
    ["ge-0/0/0", "ge-0/0/1", "ge-0/0/2"]);
  assert.deepEqual(expandPortKey("ge-0/0/0,ge-0/0/10"), ["ge-0/0/0", "ge-0/0/10"]);
  assert.deepEqual(expandPortKey("ge-0/0/00-02"),
    ["ge-0/0/00", "ge-0/0/01", "ge-0/0/02"], "zero padding is preserved");
  assert.deepEqual(expandPortKey("xe-1/0/4"), ["xe-1/0/4"], "a plain port passes through");
  assert.deepEqual(expandPortKey("ge-0/0/0-xe-1/0/3"), ["ge-0/0/0-xe-1/0/3"],
    "mismatched prefixes are not a range");
  assert.deepEqual(expandPortKey(""), [""], "an empty key yields itself, never nothing");
});

test("fpcFromPort reads the FPC slot out of a port name", () => {
  assert.equal(fpcFromPort("ge-0/0/1"), 0);
  assert.equal(fpcFromPort("xe-2/0/39"), 2);
  assert.equal(fpcFromPort("GE-1/0/0"), 1, "case does not matter");
  assert.equal(fpcFromPort("irb"), null);
});

test("fmtSpeedDuplex matches the Python's formatting", () => {
  assert.equal(fmtSpeedDuplex(1000, true), "1G/full");
  assert.equal(fmtSpeedDuplex(10000, false), "10G/half");
  assert.equal(fmtSpeedDuplex(100, true), "100M/full");
  assert.equal(fmtSpeedDuplex(100, null, "half"), "100M/half");
  assert.equal(fmtSpeedDuplex(0, null), "");
  assert.equal(fmtSpeedDuplex(null, true), "full");
  assert.equal(fmtSpeedDuplex(2500, null), "2500M", "not a clean multiple of 1000");
});

test("portStatus prefers disabled over link state", () => {
  assert.equal(portStatus(true, true), "disabled");
  assert.equal(portStatus(true, false), "up");
  assert.equal(portStatus(false, false), "down");
  assert.equal(portStatus(null, null), "");
});

test("first returns the earliest usable key, else the fallback", () => {
  assert.equal(first({ a: "", b: "x" }, ["a", "b"]), "x");
  assert.equal(first({ a: 0 }, ["a"]), 0, "zero is a value");
  assert.equal(first({}, ["a"], "fb"), "fb");
});

test("mergeSwitch lets later sources fill blanks but never overwrite", () => {
  const store = new Map();
  mergeSwitch(store, asSwitchRecord({ mac: "AA:BB:CC:00:00:01", name: "sw1", model: "" }));
  mergeSwitch(store, asSwitchRecord({ mac: "aabbcc000001", name: "ignored", model: "EX4400" }));
  const sw = store.get("aabbcc000001");
  assert.equal(sw.name, "sw1", "the first non-empty name wins");
  assert.equal(sw.model, "EX4400", "a blank field is filled by a later source");
  assert.equal(store.size, 1, "the same MAC in any format is one switch");
});

test("asSwitchRecord derives connected from a status string", () => {
  assert.equal(asSwitchRecord({ status: "connected" }).connected, true);
  assert.equal(asSwitchRecord({ status: "disconnected" }).connected, false);
  assert.equal(asSwitchRecord({ connected: true, status: "whatever" }).connected, true);
  assert.equal(asSwitchRecord({}).connected, undefined);
  assert.equal(asSwitchRecord({ chassis_mac: "AA" }).vc_mac, "AA", "chassis_mac is a vc_mac");
});

test("memberRecord names an unnamed VC member after its chassis and slot", () => {
  const parent = { mac: "aabbcc000001", vc_mac: "aabbcc000001", name: "stack-1", site_id: "s1", connected: true };
  const m = memberRecord(parent, { mac: "aabbcc000002", member_id: 1 }, 0);
  assert.equal(m.name, "stack-1 (fpc 1)");
  assert.equal(m.vc_mac, "aabbcc000001");
  assert.equal(m.member_id, 1);
  assert.equal(m.site_id, "s1", "inherited from the chassis");
  assert.equal(m.connected, true);
  assert.equal(memberRecord(parent, { mac: "x", name: "given" }, 3).name, "given");
});

test("isSecondaryVcMember only flags a member that is not the chassis", () => {
  assert.equal(isSecondaryVcMember({ mac: "a1", vc_mac: "a2" }), true);
  assert.equal(isSecondaryVcMember({ mac: "a1", vc_mac: "a1" }), false);
  assert.equal(isSecondaryVcMember({ mac: "a1" }), false);
});

test("extractStatPorts reads all three shapes device stats use", () => {
  assert.equal(extractStatPorts({ ports: [{ port_id: "ge-0/0/0" }] }).length, 1);
  assert.equal(extractStatPorts({ port_stat: [{ port_id: "ge-0/0/1" }] }).length, 1);
  assert.equal(extractStatPorts({ interfaces: [{ port_id: "ge-0/0/2" }] }).length, 1);
  // A map keyed by port id: the key fills port_id in.
  const fromMap = extractStatPorts({ ports: { "ge-0/0/3": { up: true } } });
  assert.equal(fromMap[0].port_id, "ge-0/0/3");
  assert.equal(fromMap[0].up, true);
  // The port's own id wins over the map key.
  assert.equal(extractStatPorts({ ports: { k: { port_id: "real" } } })[0].port_id, "real");
});

test("harvestPortConfig resolves usage against port_usages and expands ranges", () => {
  const mapping = new Map();
  const ok = harvestPortConfig({
    port_config: {
      "ge-0/0/0-2": { usage: "access-voice", description: "" },
      "ge-0/0/10": { usage: "uplink", disabled: true, poe_disabled: false },
    },
    port_usages: {
      "access-voice": {
        mode: "access", port_network: "voice", networks: ["voice", "data"],
        port_auth: "dot1x", description: "Voice access", speed: "auto",
      },
      uplink: { mode: "trunk", port_network: "mgmt" },
    },
  }, "aabbcc000001", mapping);

  assert.equal(ok, true);
  assert.equal(mapping.size, 4, "a 3-port range plus one single port");
  const p0 = mapping.get("aabbcc000001|ge-0/0/0");
  assert.equal(p0.usage, "access-voice");
  assert.equal(p0.mode, "access");
  assert.equal(p0.port_network, "voice");
  assert.equal(p0.networks, "voice,data", "a network list is joined");
  assert.equal(p0.port_auth, "dot1x");
  assert.equal(p0.description, "Voice access", "falls back to the usage description");

  const up = mapping.get("aabbcc000001|ge-0/0/10");
  assert.equal(up.disabled, true);
  assert.equal(up.poe_disabled, false, "an explicit false on the port beats the usage default");

  assert.equal(harvestPortConfig({}, "x", mapping), false);
  assert.equal(harvestPortConfig({ port_config: {} }, "x", mapping), false);
});

test("indexSwitches indexes by MAC and serial, and maps a VC MAC to a member", () => {
  const member = { mac: "aabbcc000002", vc_mac: "aabbcc0000ff", serial: "s2" };
  const { byMac, bySerial } = indexSwitches([member]);
  assert.equal(byMac.get("aabbcc000002"), member);
  assert.equal(bySerial.get("S2"), member, "serials index uppercased");
  assert.equal(byMac.get("aabbcc0000ff"), member, "an unseen VC MAC resolves to a member");
});

// ---------------------------------------------------------------------------
// The virtual-chassis attribution, which is the whole reason for fpcMembers
// ---------------------------------------------------------------------------

const VC_CHASSIS = {
  mac: "aabbcc000001", vc_mac: "aabbcc000001", name: "stack-1", model: "EX4400-48P",
  serial: "S1", site_id: "s1", id: "dev-1", connected: true, member_id: 0,
};
const VC_MEMBER = {
  mac: "aabbcc000002", vc_mac: "aabbcc000001", name: "stack-1-fpc1", model: "EX4400-48P",
  serial: "S2", site_id: "s1", id: "dev-2", connected: true, member_id: 1,
};

test("a port reported against the chassis is attributed to its FPC member", () => {
  const rows = buildPortRows(
    [{ id: "s1", name: "HQ" }],
    [VC_CHASSIS, VC_MEMBER],
    [
      { mac: "aabbcc000001", port_id: "ge-0/0/1", up: true, speed: 1000, full_duplex: true },
      { mac: "aabbcc000001", port_id: "ge-1/0/1", up: true, speed: 1000, full_duplex: true },
    ],
    [],
    new Map(),
  );
  assert.equal(rows.length, 2);

  const fpc0 = rows.find((r) => r.Port === "ge-0/0/1");
  assert.equal(fpc0["Switch Name"], "stack-1", "fpc 0 belongs to the chassis");
  assert.equal(fpc0["Switch MAC"], "aabbcc000001");

  const fpc1 = rows.find((r) => r.Port === "ge-1/0/1");
  assert.equal(fpc1["Switch Name"], "stack-1-fpc1", "fpc 1 is re-attributed to the member");
  assert.equal(fpc1["Switch MAC"], "aabbcc000002");
  assert.equal(fpc1["VC MAC"], "aabbcc000001", "the chassis MAC is recorded alongside");
  assert.equal(fpc1["Switch Serial"], "S2");
  assert.equal(fpc1.Site, "HQ");
});

test("module_stat maps an FPC slot to a member by serial or MAC", () => {
  const rows = buildPortRows(
    [{ id: "s1", name: "HQ" }],
    // No member_id on the member, so only module_stat can place it.
    [VC_CHASSIS, { ...VC_MEMBER, member_id: undefined }],
    [{ mac: "aabbcc000001", port_id: "ge-1/0/5", up: true }],
    [{ mac: "aabbcc000001", module_stat: [{ idx: 1, serial: "S2" }] }],
    new Map(),
  );
  assert.equal(rows[0]["Switch Name"], "stack-1-fpc1");
  assert.equal(rows[0]["Switch MAC"], "aabbcc000002");
});

test("port config is found via the member, the reporter or the chassis MAC", () => {
  const cfg = new Map([["aabbcc000002|ge-1/0/1", {
    usage: "access", mode: "access", port_network: "data", networks: "data", disabled: false,
  }]]);
  const rows = buildPortRows(
    [{ id: "s1", name: "HQ" }], [VC_CHASSIS, VC_MEMBER],
    [{ mac: "aabbcc000001", port_id: "ge-1/0/1", up: true }], [], cfg,
  );
  assert.equal(rows[0]["Port Usage / Profile"], "access",
    "config keyed on the member MAC still attaches");
  assert.equal(rows[0]["Mode (access/trunk)"], "access");
  assert.equal(rows[0]["Allowed Networks / VLANs"], "data");
});

test("a configured port nobody reported still appears", () => {
  const cfg = new Map([["aabbcc000001|ge-0/0/47", { usage: "spare", disabled: true }]]);
  const rows = buildPortRows(
    [{ id: "s1", name: "HQ" }], [VC_CHASSIS], [], [], cfg,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Port, "ge-0/0/47");
  assert.equal(rows[0]["Port Status"], "disabled");
  assert.equal(rows[0]["Port Usage / Profile"], "spare");
  assert.equal(rows[0]["Link Up"], "", "no link state was ever reported");
});

test("stats and org ports layer onto one row per port", () => {
  const rows = buildPortRows(
    [{ id: "s1", name: "HQ" }], [VC_CHASSIS],
    [{ mac: "aabbcc000001", port_id: "ge-0/0/1", up: true, speed: 1000, full_duplex: true }],
    [{
      mac: "aabbcc000001", status: "connected", version: "23.4R2", ip: "10.0.0.9",
      ports: [{ port_id: "ge-0/0/1", neighbor_system_name: "ap-1", poe_on: true, power_draw: 12.5 }],
    }],
    new Map(),
  );
  assert.equal(rows.length, 1, "the same port from two sources is one row");
  const r = rows[0];
  assert.equal(r["Speed/Duplex"], "1G/full", "from org port stats");
  assert.equal(r["Neighbor System Name"], "ap-1", "from device stats");
  assert.equal(r["PoE On"], "true");
  assert.equal(r["PoE Power Draw (W)"], 12.5);
  assert.equal(r.Firmware, "23.4R2");
  assert.equal(r["Switch IP"], "10.0.0.9");
  assert.equal(r["Switch Status"], "connected");
});

test("portCoverage and switchHasPorts spot a switch that reported nothing", () => {
  const rows = buildPortRows([{ id: "s1", name: "HQ" }], [VC_CHASSIS, VC_MEMBER],
    [{ mac: "aabbcc000001", port_id: "ge-0/0/1", up: true }], [], new Map());
  const { owners, vcs } = portCoverage(rows);
  assert.ok(switchHasPorts(VC_CHASSIS, owners, vcs));
  assert.ok(switchHasPorts(VC_MEMBER, owners, vcs), "a member of a covered chassis counts");
  assert.ok(!switchHasPorts({ mac: "aabbcc0000ee" }, owners, vcs));
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

const SITES = [{ id: "s1", name: "HQ", country_code: "CA", timezone: "America/Toronto" }];

const routes = (o = {}) => ({
  "/orgs/org-1/sites": SITES,
  "/orgs/org-1/inventory/search": {
    results: [{
      mac: "aabbcc000001", vc_mac: "aabbcc000001", name: "stack-1", model: "EX4400-48P",
      serial: "S1", site_id: "s1", id: "dev-1", status: "connected",
      members: [{ mac: "aabbcc000002", serial: "S2", member_id: 1 }],
    }],
    total: 1,
  },
  "/orgs/org-1/inventory": [{
    mac: "aabbcc000001", vc_mac: "aabbcc000001", name: "stack-1", model: "EX4400-48P",
    serial: "S1", site_id: "s1", id: "dev-1", status: "connected",
  }],
  "/sites/s1/devices": [{
    mac: "aabbcc000001", id: "dev-1", name: "stack-1", site_id: "s1", status: "connected",
    port_config: { "ge-0/0/0-1": { usage: "access" } },
    port_usages: { access: { mode: "access", port_network: "data", networks: ["data"] } },
  }],
  "/orgs/org-1/stats/ports/search": {
    results: [
      { mac: "aabbcc000001", port_id: "ge-0/0/0", up: true, speed: 1000, full_duplex: true },
      { mac: "aabbcc000001", port_id: "ge-1/0/0", up: false },
    ],
    total: 2,
  },
  "/orgs/org-1/stats/devices": [{
    mac: "aabbcc000001", status: "connected", version: "23.4R2", ip: "10.0.0.9", site_id: "s1",
  }],
  "/sites/s1/stats/devices": [],
  ...o,
});

test("the tool produces four sheets with the 41-column port sheet", async () => {
  stubMist(routes());
  const result = await tool.run(testCtx());
  assert.deepEqual(result.sheets.map((s) => s.name),
    ["Summary", "Switch Ports", "Sites", "Switches"]);
  const ports = sheetNamed(result, "Switch Ports");
  assert.equal(ports.columns.length, 41);
  assert.deepEqual(ports.columns.map((c) => c.header), PORT_COLUMNS);
  assert.equal(ports.table, "SwitchPorts", "the port sheet is an Excel Table");
  assert.match(result.filename, /^mist_switch_ports_Acme_Corp_\d{8}_\d{6}\.xlsx$/);
});

test("end to end, the VC member gets its own port rows and config attaches", async () => {
  stubMist(routes());
  const result = await tool.run(testCtx());
  const rows = sheetNamed(result, "Switch Ports").rows;
  // ge-0/0/0 and ge-1/0/0 are reported; ge-0/0/1 is configured by the
  // "ge-0/0/0-1" range but reported nowhere, and still belongs in the export.
  assert.equal(rows.length, 3);
  const unreported = rows.find((r) => r.Port === "ge-0/0/1");
  assert.equal(unreported["Port Usage / Profile"], "access");
  assert.equal(unreported["Link Up"], "");

  const chassisPort = rows.find((r) => r.Port === "ge-0/0/0");
  assert.equal(chassisPort["Switch Name"], "stack-1");
  assert.equal(chassisPort["Port Usage / Profile"], "access", "from the inline port_config");
  assert.equal(chassisPort["Allowed Networks / VLANs"], "data");
  assert.equal(chassisPort["Speed/Duplex"], "1G/full");
  assert.equal(chassisPort.Site, "HQ");

  const memberPort = rows.find((r) => r.Port === "ge-1/0/0");
  assert.equal(memberPort["Switch MAC"], "aabbcc000002", "fpc 1 belongs to the member");
  assert.equal(memberPort["VC MAC"], "aabbcc000001");
  assert.equal(memberPort["Port Status"], "down");
});

test("the Switches sheet flags which switches made it into the export", async () => {
  stubMist(routes());
  const result = await tool.run(testCtx());
  const rows = sheetNamed(result, "Switches").rows;
  assert.equal(rows.length, 2, "chassis plus member");
  assert.ok(rows.every((r) => r["Ports In Export"] === "yes"));
  const member = rows.find((r) => r.MAC === "aabbcc000002");
  assert.equal(member["VC MAC"], "aabbcc000001");
  assert.equal(member["FPC / Member"], 1);
});

test("falls back to per-site port stats when the org search is unavailable", async () => {
  const calls = stubMist(routes({
    "/orgs/org-1/stats/ports/search": () => { throw new Error("403 forbidden"); },
    "/sites/s1/stats/ports/search": {
      results: [{ mac: "aabbcc000001", port_id: "ge-0/0/0", up: true }], total: 1,
    },
  }));
  const result = await tool.run(testCtx());
  assert.ok(calls.some((c) => c.startsWith("/sites/s1/stats/ports/search")),
    "the per-site endpoint must be tried");
  assert.ok(sheetNamed(result, "Switch Ports").rows.length >= 1);
});

test("falls back to per-device stats for a switch that reports no ports", async () => {
  const calls = stubMist(routes({
    "/orgs/org-1/stats/ports/search": { results: [], total: 0 },
    "/sites/s1/stats/ports/search": { results: [], total: 0 },
    "/sites/s1/stats/devices/dev-1": {
      mac: "aabbcc000001", status: "connected",
      ports: [{ port_id: "ge-0/0/0", up: true }],
    },
  }));
  const result = await tool.run(testCtx());
  assert.ok(calls.some((c) => c === "/sites/s1/stats/devices/dev-1"),
    "the per-device endpoint is the last resort");
  assert.ok(sheetNamed(result, "Switch Ports").rows.some((r) => r.Port === "ge-0/0/0"));
});

test("skipConfig drops the config columns but keeps the stats rows", async () => {
  const calls = stubMist(routes());
  const result = await tool.run(testCtx({ params: { skipConfig: true } }));
  assert.ok(!calls.some((c) => c === "/sites/s1/devices/dev-1"),
    "no per-switch config fetch");
  const rows = sheetNamed(result, "Switch Ports").rows;
  assert.ok(rows.length >= 2);
  assert.equal(rows.find((r) => r.Port === "ge-0/0/0")["Port Usage / Profile"], "",
    "usage came only from config");
});

test("the Summary sheet counts ports by state", async () => {
  stubMist(routes());
  const result = await tool.run(testCtx());
  const get = (item) => sheetNamed(result, "Summary").rows.find((r) => r.Item === item)?.Value;
  assert.equal(get("Sites"), 1);
  assert.equal(get("Switches / VC members"), 2);
  assert.equal(get("VC secondary members"), 1);
  assert.equal(get("Port rows"), 3, "two reported plus one configured-but-unreported");
  assert.equal(get("Ports up"), 1);
  assert.equal(get("Ports down"), 1);
  assert.equal(get("Configured port entries"), 2, "ge-0/0/0-1 expanded to two");
});

test("one site: skips the org-wide port and stats calls and stays on that site", async () => {
  const calls = stubMist(routes({
    "/orgs/org-1/sites": [...SITES, { id: "s2", name: "Branch" }],
    "/sites/s1/stats/ports/search": {
      results: [{ mac: "aabbcc000001", port_id: "ge-0/0/0", up: true, speed: 1000 }],
      total: 1,
    },
  }));
  const result = await tool.run(testCtx({ params: { allSites: false, siteId: "s1" } }));
  assert.ok(!calls.some((c) => c.startsWith("/orgs/org-1/stats/")), "no org-wide port or device stats");
  assert.ok(calls.some((c) => c.startsWith("/sites/s1/stats/ports/search")), "per-site port search used");
  assert.ok(!calls.some((c) => c.startsWith("/sites/s2/")), "the other site is never touched");
  assert.ok(sheetNamed(result, "Switch Ports").rows.some((r) => r.Port === "ge-0/0/0"));
  assert.deepEqual(sheetNamed(result, "Sites").rows.map((r) => r.Site), ["HQ"]);
  assert.match(result.filename, /^mist_switch_ports_Acme_Corp_HQ_/);
});
