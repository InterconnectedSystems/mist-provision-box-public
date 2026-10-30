// Site Alarms, added as written: one site or all, filters, failures, and the
// alarm-definition fallback.

import { strict as assert } from "node:assert";
import test from "node:test";

import tool from "../tools/site-alarms.js";
import { sheetNamed, stubMist, testCtx } from "./helpers.mjs";

const SITES = [{ id: "s1", name: "HQ" }, { id: "s2", name: "Branch" }];
const DEFS = [
  { key: "switch_down", display: "Switch offline", severity: "critical", group: "infrastructure" },
  { key: "ap_bad_cable", display: "Bad cable", severity: "warn", group: "infrastructure" },
];
const alarm = (o) => ({ id: o.id, type: o.type, timestamp: 1700000000, count: 1, acked: false, ...o });

const routes = (o = {}) => ({
  "/orgs/org-1/sites": SITES,
  "/const/alarm_defs": DEFS,
  "/sites/s1/alarms/search": { results: [
    alarm({ id: "a1", type: "switch_down", switches: ["aabbcc000001"] }),
    alarm({ id: "a2", type: "ap_bad_cable", acked: true, ack_admin_name: "ops" }),
  ], total: 2 },
  "/sites/s2/alarms/search": { results: [alarm({ id: "a3", type: "ap_bad_cable", timestamp: 1700000100 })], total: 1 },
  ...o,
});

test("all sites: every alarm, newest first, with readable names", async () => {
  stubMist(routes());
  const result = await tool.run(testCtx({ params: { allSites: true, duration: "1d", severity: "" } }));
  const rows = sheetNamed(result, "Alarms").rows;
  assert.deepEqual(rows.map((r) => r.id), ["a3", "a1", "a2"]);
  assert.equal(rows.find((r) => r.id === "a1").name, "Switch offline");
  assert.equal(rows.find((r) => r.id === "a1").devices, "aa:bb:cc:00:00:01");
  assert.deepEqual(sheetNamed(result, "By Site").rows.map((r) => r.site), ["HQ", "Branch"],
    "the site with a critical alarm sorts first");
});

test("one site: only that site is queried", async () => {
  const calls = stubMist(routes());
  const result = await tool.run(testCtx({ params: { allSites: false, siteId: "s2", duration: "7d", severity: "" } }));
  assert.deepEqual(sheetNamed(result, "Alarms").rows.map((r) => r.id), ["a3"]);
  assert.ok(!calls.some((c) => c.startsWith("/sites/s1/")));
  assert.ok(calls.some((c) => c.startsWith("/sites/s2/alarms/search") && c.includes("duration=7d")));
  assert.match(result.filename, /^mist_alarms_Branch_7d_Acme_Corp_/);
});

test("severity and unacknowledged filters", async () => {
  stubMist(routes());
  const crit = await tool.run(testCtx({ params: { allSites: true, duration: "1d", severity: "critical" } }));
  assert.deepEqual(sheetNamed(crit, "Alarms").rows.map((r) => r.id), ["a1"]);
  const open = await tool.run(testCtx({ params: { allSites: true, duration: "1d", severity: "", unackedOnly: true } }));
  assert.deepEqual(sheetNamed(open, "Alarms").rows.map((r) => r.id), ["a3", "a1"]);
});

test("a failing site is listed, not fatal; missing definitions fall back to type keys", async () => {
  stubMist(routes({
    "/sites/s2/alarms/search": () => { throw new Error("boom"); },
    "/const/alarm_defs": () => { throw new Error("nope"); },
  }));
  const result = await tool.run(testCtx({ params: { allSites: true, duration: "1d", severity: "" } }));
  assert.deepEqual(sheetNamed(result, "Failed Sites").rows.map((r) => r.site), ["Branch"]);
  assert.equal(sheetNamed(result, "Alarms").rows[0].name, "switch_down");
  assert.match(result.summary, /1 site\(s\) failed/);
});

test("no site picked is a clear error", async () => {
  stubMist(routes());
  await assert.rejects(tool.run(testCtx({ params: { allSites: false, duration: "1d" } })), /Pick a site/);
});
