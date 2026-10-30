// Switch PSU Status, added as written: PSU classing, per-member health with the
// worst member deciding a VC, scope, and failing sites. VC members the org
// inventory knows about but that do not report are flagged as missing.

import { strict as assert } from "node:assert";
import test from "node:test";

import tool from "../tools/switch-psu-status.js";
import { sheetNamed, stubMist, testCtx } from "./helpers.mjs";

const SITES = [{ id: "s1", name: "HQ" }, { id: "s2", name: "Branch" }];
const psus = (...st) => st.map((status, i) => ({ name: `Power Supply ${i}`, status }));
const sw = (o) => ({ type: "switch", status: "connected", model: "EX4400-48P", ...o });

const routes = (o = {}) => ({
  "/orgs/org-1/sites": SITES,
  "/orgs/org-1/inventory": [
    // Mist's virtual chassis row: its serial is the VC MAC, not a member.
    { type: "switch", mac: "aabbcc000003", vc_mac: "aabbcc000003", serial: "AABBCC000003" },
    { type: "switch", mac: "aabbcc000013", vc_mac: "aabbcc000003", serial: "A" },
    { type: "switch", mac: "aabbcc000023", vc_mac: "aabbcc000003", serial: "B" },
    // Not a VC: its chassis serial differs from its module serials.
    { type: "switch", mac: "aabbcc000001", serial: "CORE-CHASSIS" },
  ],
  "/sites/s1/stats/devices": [
    sw({ name: "core", mac: "aabbcc000001", module_stat: [{ fpc_idx: 0, psus: psus("ok", "ok") }] }),
    sw({ name: "edge", mac: "aabbcc000002", module_stat: [{ fpc_idx: 0, psus: psus("OK", "absent") }] }),
    // VC: member 0 redundant, member 1 has a failed supply -> the switch is failed.
    sw({ name: "vc", mac: "aabbcc000003", module_stat: [
      { fpc_idx: 1, vc_role: "backup", serial: "B", psus: psus("Online", "Check") },
      { fpc_idx: 0, vc_role: "master", serial: "A", psus: psus("ok", "ok") },
    ] }),
    sw({ name: "dark", mac: "aabbcc000004", status: "disconnected", module_stat: [] }),
    { type: "ap", name: "not-a-switch" },
  ],
  "/sites/s2/stats/devices": [
    sw({ name: "br", mac: "aabbcc000005", module_stat: [{ fpc_idx: 0, psus: psus("ok", "weird") }] }),
  ],
  ...o,
});

const run = (params) => tool.run(testCtx({ params: { allSites: true, includeOffline: true, ...params } }));

test("all sites: each switch graded, worst VC member wins, failures sort first", async () => {
  stubMist(routes());
  const result = await run({});
  const rows = sheetNamed(result, "Switches").rows;
  const health = Object.fromEntries(rows.map((r) => [r.name, r.health]));
  assert.deepEqual(health, {
    core: "Redundant", edge: "Not redundant", vc: "PSU failed / no power", dark: "No PSU data", br: "Not redundant",
  });
  assert.equal(rows[0].name, "vc", "failed switches lead the sheet");
  const vc = rows.find((r) => r.name === "vc");
  assert.equal(vc.members, 2);
  assert.equal(vc.detail, "FPC 0: Power Supply 0=ok, Power Supply 1=ok\nFPC 1: Power Supply 0=Online, Power Supply 1=Check");
  assert.equal(rows.find((r) => r.name === "edge").absent, 1);
  assert.equal(rows.find((r) => r.name === "br").unknown, 1);
  assert.ok(!rows.some((r) => r.name === "not-a-switch"));
  assert.match(result.summary,
    /^5 switch\(es\): 1 with a failed or unpowered PSU, 0 with a missing member, 2 not redundant, 1 redundant$/);
  assert.match(result.filename, /^mist_switch_psu_all_sites_Acme_Corp_/);
});

test("PSU sheet keeps the raw text and the class", async () => {
  stubMist(routes());
  const rows = sheetNamed(await run({}), "PSUs").rows;
  const check = rows.find((r) => r.raw === "Check");
  assert.equal(check.cls, "Failed");
  assert.equal(check.member, 1);
  assert.equal(check.role, "backup");
  assert.equal(check.__style, "red");
  assert.equal(rows.find((r) => r.raw === "weird").cls, "Unknown");
  assert.equal(rows.find((r) => r.raw === "absent").cls, "Empty slot");
});

test("By Site puts the site with a failure first", async () => {
  stubMist(routes());
  const rows = sheetNamed(await run({}), "By Site").rows;
  assert.deepEqual(rows.map((r) => r.site), ["HQ", "Branch"]);
  assert.deepEqual({ ...rows[0], __style: undefined },
    { site: "HQ", total: 4, failed: 1, missing: 0, single: 1, nodata: 1, redundant: 1, offline: 1, __style: undefined });
});

test("disconnected switches can be left out", async () => {
  stubMist(routes());
  const rows = sheetNamed(await run({ includeOffline: false }), "Switches").rows;
  assert.ok(!rows.some((r) => r.name === "dark"));
});

test("one site: only that site is queried", async () => {
  const calls = stubMist(routes());
  const result = await run({ allSites: false, siteId: "s2" });
  assert.deepEqual(sheetNamed(result, "Switches").rows.map((r) => r.name), ["br"]);
  assert.ok(!calls.some((c) => c.startsWith("/sites/s1/")));
  assert.match(result.filename, /^mist_switch_psu_Branch_Acme_Corp_/);
});

test("a failing site is listed, not fatal", async () => {
  stubMist(routes({ "/sites/s2/stats/devices": () => { throw new Error("boom"); } }));
  const result = await run({});
  assert.deepEqual(sheetNamed(result, "Failed Sites").rows.map((r) => r.site), ["Branch"]);
  assert.equal(sheetNamed(result, "Switches").rows.length, 4);
  assert.match(result.summary, /1 site\(s\) failed/);
});

test("no site picked is a clear error", async () => {
  stubMist(routes());
  await assert.rejects(run({ allSites: false }), /Pick a site/);
});

// A 4-member VC: inventory knows 4 members, module_stat reports only 3, all
// healthy. Before, the 3 that report decided it and it read as Redundant.
const STACK = "aabbcc0000a0";
const stackInv = [
  { type: "switch", serial: STACK.toUpperCase(), mac: STACK, vc_mac: STACK, model: "EX4400-48P" },
  ...["S0", "S1", "S2", "S3"].map((serial, i) => ({
    type: "switch", serial, mac: `aabbcc0000b${i}`, vc_mac: STACK, model: "EX4400-48P",
  })),
];
const stack = (mods) => sw({ name: "stack", mac: STACK, module_stat: mods });
const mod = (i, o = {}) => ({ fpc_idx: i, serial: `S${i}`, mac: `aabbcc0000b${i}`, psus: psus("ok", "ok"), ...o });
const stackRoutes = (mods, inv = stackInv) => routes({
  "/orgs/org-1/inventory": inv,
  "/sites/s1/stats/devices": [stack(mods)],
  "/sites/s2/stats/devices": [],
});

test("4-member VC with a member not reporting is Member missing, not Redundant", async () => {
  stubMist(stackRoutes([mod(0), mod(1), mod(3)]));
  const result = await run({});
  const row = sheetNamed(result, "Switches").rows.find((r) => r.name === "stack");
  assert.equal(row.health, "Member missing");
  assert.equal(row.members, "3/4");
  assert.equal(row.__style, "red");
  assert.match(row.detail, /FPC \?: S2 not reporting/);
  const psuRow = sheetNamed(result, "PSUs").rows.find((r) => r.serial === "S2");
  assert.equal(psuRow.cls, "Member missing");
  assert.deepEqual(sheetNamed(result, "By Site").rows[0],
    { site: "HQ", total: 1, failed: 0, missing: 1, single: 0, nodata: 0, redundant: 0, offline: 0, __style: "red" });
  assert.match(result.summary, /0 with a failed or unpowered PSU, 1 with a missing member/);
});

test("a member reporting as not present does not count on its stale PSU readings", async () => {
  stubMist(stackRoutes([mod(0), mod(1), mod(2, { vc_state: "not-present" }), mod(3)]));
  const result = await run({});
  const row = sheetNamed(result, "Switches").rows.find((r) => r.name === "stack");
  assert.equal(row.health, "Member missing");
  assert.match(row.detail, /FPC 2: S2 not reporting \(last: Power Supply 0=ok, Power Supply 1=ok\)/);
});

test("all 4 members reporting is Redundant", async () => {
  stubMist(stackRoutes([mod(0), mod(1), mod(2, { vc_state: "present" }), mod(3)]));
  const row = sheetNamed(await run({}), "Switches").rows.find((r) => r.name === "stack");
  assert.equal(row.health, "Redundant");
  assert.equal(row.members, 4);
});

test("members are matched by MAC when the inventory has no serial", async () => {
  const inv = stackInv.slice(1).map(({ serial, ...r }) => r);
  stubMist(stackRoutes([mod(0), mod(1), mod(2), mod(3)], inv));
  const row = sheetNamed(await run({}), "Switches").rows.find((r) => r.name === "stack");
  assert.equal(row.health, "Redundant");
});

test("an inventory failure only turns off the missing-member check", async () => {
  stubMist(routes({ "/orgs/org-1/inventory": () => { throw new Error("nope"); } }));
  const ctx = testCtx({ params: { allSites: true, includeOffline: true } });
  const result = await tool.run(ctx);
  assert.equal(sheetNamed(result, "Switches").rows.length, 5);
  assert.ok(ctx.logs.some(([, m]) => /missing VC members cannot be detected/.test(m)));
});

// Shapes seen on a live org (serials and MACs made up).
const one = (name, mods, o = {}) => routes({
  "/sites/s1/stats/devices": [sw({ name, mac: "aabbcc0000c0", module_stat: mods, ...o })],
  "/sites/s2/stats/devices": [],
  ...o.routes,
});
const rowOf = async (name) => sheetNamed(await run({}), "Switches").rows.find((r) => r.name === name);

test('"Present" is installed but unpowered, so a VC with it is not Redundant', async () => {
  stubMist(one("tor-vc", [
    { fpc_idx: 0, vc_role: "master", vc_state: "present", serial: "N0", psus: psus("present", "ok") },
    { fpc_idx: 1, vc_role: "backup", vc_state: "present", serial: "N1", psus: psus("present", "ok") },
    { fpc_idx: 2, vc_role: "linecard", vc_state: "present", serial: "N2", psus: psus("ok", "absent") },
  ]));
  const result = await run({});
  const row = sheetNamed(result, "Switches").rows.find((r) => r.name === "tor-vc");
  assert.equal(row.health, "PSU failed / no power");
  assert.equal(row.nopower, 2);
  assert.equal(row.ok, 3);
  const p = sheetNamed(result, "PSUs").rows.filter((r) => r.raw === "present");
  assert.deepEqual(p.map((r) => [r.member, r.cls, r.__style]), [[0, "No power", "red"], [1, "No power", "red"]]);
});

test('one OK and two "Present" PSUs is not Redundant, and PSUs list in name order', async () => {
  stubMist(one("desk", [{ fpc_idx: 0, vc_role: "master", serial: "F0", psus: [
    { name: "Power Supply 2", status: "present" }, { name: "Power Supply 0", status: "ok" },
    { name: "Power Supply 1", status: "present" }] }]));
  const row = await rowOf("desk");
  assert.equal(row.health, "PSU failed / no power");
  assert.equal(row.detail, "Power Supply 0=ok, Power Supply 1=present, Power Supply 2=present");
});

test("a disconnected VC with no module data is No PSU data, not missing members", async () => {
  stubMist(one("dark-vc", [{ fpc_idx: null, serial: null, psus: null }], {
    status: "disconnected",
    routes: { "/orgs/org-1/inventory": [
      { mac: "aabbcc0000c0", vc_mac: "aabbcc0000c0", serial: "AABBCC0000C0" },
      { mac: "aabbcc0000c1", vc_mac: "aabbcc0000c0", serial: "J1" },
      { mac: "aabbcc0000c2", vc_mac: "aabbcc0000c0", serial: "J2" },
    ] },
  }));
  const row = await rowOf("dark-vc");
  assert.equal(row.health, "No PSU data");
  assert.equal(row.members, 0);
});

test("CX chassis: PSU modules pool into one chassis; modules without PSUs are skipped", async () => {
  const psuMod = (name, status) => ({ fpc_idx: null, serial: "X", model: "R0X35A", psus: [{ name, status }] });
  stubMist(one("cx6405", [
    { fpc_idx: null, vc_role: "master", vc_state: "ready", serial: "M1", psus: null },
    { fpc_idx: null, vc_role: "backup", vc_state: "ready", serial: "M2", psus: null },
    { fpc_idx: 3, serial: "L3", psus: null },
    { fpc_idx: 5, serial: "", psus: null },
    psuMod("1/1", "ok"), psuMod("1/2", "ok"), psuMod("1/3", "absent"), psuMod("1/4", "absent"),
    { fpc_idx: null, serial: "FAN", model: "6400 Fan Tray", psus: null },
  ]));
  const row = await rowOf("cx6405");
  assert.equal(row.health, "Redundant");
  assert.equal(row.members, 1);
  assert.equal(row.detail, "1/1=ok, 1/2=ok, 1/3=absent, 1/4=absent");
});

test("CX6300: the empty first module is ignored; ok + absent is Not redundant", async () => {
  stubMist(one("cx6300", [
    { fpc_idx: null, serial: null, psus: null },
    { fpc_idx: 1, vc_role: "master", vc_state: "ready", serial: "SG1", psus: [
      { name: "1/2", status: "absent" }, { name: "1/1", status: "ok" }] },
  ]));
  const row = await rowOf("cx6300");
  assert.equal(row.health, "Not redundant");
  assert.equal(row.members, 1);
});
