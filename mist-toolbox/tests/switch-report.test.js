// Stubbed Mist in, sheet out, for the port of mist_switch_report.js.

import { strict as assert } from "node:assert";
import test from "node:test";

import tool, { formatUptime, vcMembers } from "../tools/switch-report.js";
import { sheetNamed, stubMist, testCtx } from "./helpers.mjs";

const SITES = [{ id: "site-2", name: "branch" }, { id: "site-1", name: "HQ" }];

const HQ_SWITCHES = [
  {
    id: "d2", name: "idf-2", model: "EX2300-48P", serial: "S2", mac: "aa:bb",
    version: "22.4R3", status: "connected", ip_stat: { ip: "10.0.0.2" }, uptime: 90061,
  },
  {
    id: "d1", name: "core", model: "EX4400-24T", serial: "S1", version: "23.4R2-S3",
    status: "connected", ip: "10.0.0.1",
    module_stat: [
      { fpc_idx: 0, vc_role: "master", serial: "M0", version: "23.4R2-S3" },
      { fpc_idx: 1, vc_role: "backup", serial: "M1", version: "23.4R2-S3" },
    ],
  },
];

function routes(overrides = {}) {
  return {
    "/orgs/org-1/sites": SITES,
    "/sites/site-1/stats/devices": HQ_SWITCHES,
    "/sites/site-2/stats/devices": [{ id: "d3", hostname: "br-sw", version: "22.4R3" }],
    ...overrides,
  };
}

test("one Switches sheet with the original 14 columns", async () => {
  stubMist(routes());
  const result = await tool.run(testCtx());
  assert.deepEqual(result.sheets.map((s) => s.name), ["Switches"]);
  assert.equal(sheetNamed(result, "Switches").columns.length, 14);
  assert.match(result.filename, /^mist_switches_Acme_Corp_\d{8}_\d{6}\.xlsx$/);
  assert.match(result.summary, /3 switch\(es\) across 2 site\(s\), 2 distinct software version/);
});

test("rows are grouped by site, then switch name, case-insensitively", async () => {
  stubMist(routes());
  const rows = sheetNamed(await tool.run(testCtx()), "Switches").rows;
  assert.deepEqual(rows.map((r) => `${r.site}/${r.name}`), ["branch/br-sw", "HQ/core", "HQ/idf-2"]);
});

test("row fields match switchRow in the script", async () => {
  const calls = stubMist(routes());
  const rows = sheetNamed(await tool.run(testCtx()), "Switches").rows;
  const core = rows.find((r) => r.name === "core");
  assert.equal(core.vcCount, 2);
  assert.equal(core.vcDetail, "fpc0 master M0 (23.4R2-S3); fpc1 backup M1 (23.4R2-S3)");
  const idf = rows.find((r) => r.name === "idf-2");
  assert.equal(idf.ip, "10.0.0.2", "falls back to ip_stat.ip");
  assert.equal(idf.uptime, "1d 1h 1m");
  assert.equal(idf.vcCount, 1);
  assert.ok(calls.some((c) => c.startsWith("/sites/site-1/stats/devices?") && c.includes("type=switch")));
});

test("a failing site is reported, not fatal", async () => {
  stubMist(routes({ "/sites/site-2/stats/devices": () => { throw new Error("boom"); } }));
  const ctx = testCtx();
  const result = await tool.run(ctx);
  assert.equal(sheetNamed(result, "Switches").rows.length, 2);
  assert.match(result.summary, /1 site\(s\) unreadable/);
  assert.ok(ctx.logs.some(([k, m]) => k === "err" && m.includes("branch")));
});

test("the workbook builds", async () => {
  stubMist(routes());
  const ctx = testCtx();
  const blob = await ctx.xlsx.workbook((await tool.run(ctx)).sheets);
  assert.ok(blob.size > 1500);
});

test("helpers", () => {
  assert.equal(formatUptime(0), "");
  assert.equal(formatUptime(3660), "0d 1h 1m");
  assert.deepEqual(vcMembers({}), { count: 1, detail: "" });
  assert.deepEqual(vcMembers({ module_stat: [{ serial: "x" }] }), { count: 1, detail: "" });
});

test("one site: only that site's switches", async () => {
  const calls = stubMist(routes());
  const result = await tool.run(testCtx({ params: { allSites: false, siteId: "site-1" } }));
  assert.deepEqual(sheetNamed(result, "Switches").rows.map((r) => r.name), ["core", "idf-2"]);
  assert.ok(!calls.some((c) => c.startsWith("/sites/site-2/")));
  assert.match(result.filename, /^mist_switches_Acme_Corp_HQ_/);
});
