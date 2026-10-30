// Switch Additional CLI, added as written: template, site and device levels,
// switch rules, de-duplication, the cell limit, scope and failing sites.

import { strict as assert } from "node:assert";
import test from "node:test";

import tool from "../tools/switch-additional-cli.js";
import { sheetNamed, stubMist, testCtx } from "./helpers.mjs";

const SITES = [
  { id: "s1", name: "HQ", networktemplate_id: "t1" },
  { id: "s2", name: "Branch", networktemplate_id: "t1" },
];
const TEMPLATES = [{
  id: "t1", name: "Campus",
  additional_config_cmds: ["set system ntp server 192.0.2.1"],
  switch_matching: { rules: [{ name: "access", additional_config_cmds: ["set poe interface all"] }] },
}];

const routes = (o = {}) => ({
  "/orgs/org-1/sites": SITES,
  "/orgs/org-1/networktemplates": TEMPLATES,
  "/sites/s1/setting": {
    additional_config_cmds: ["set snmp location HQ", "  ", "set system ntp server 192.0.2.1"],
    switch_matching: { rules: [{ name: "core", additional_config_cmds: ["set chassis aggregated-devices"] }] },
  },
  "/sites/s1/devices": [
    { type: "switch", name: "sw-b", mac: "aabbcc000002", model: "EX4100" },
    { type: "switch", name: "sw-a", mac: "aabbcc000001", model: "EX4400", additional_config_cmds: ["set snmp location HQ"] },
  ],
  "/sites/s2/setting": {},
  "/sites/s2/devices": [{ type: "switch", name: "br-1", mac: "aabbcc000003" }],
  ...o,
});

const run = (params) => tool.run(testCtx({ params: { allSites: true, ...params } }));

test("every level is collected, blanks dropped, rules named", async () => {
  stubMist(routes());
  const result = await run({});
  const lines = sheetNamed(result, "CLI Lines").rows.map((r) => [r.level, r.site, r.rule, r.switch, r.command]);
  assert.deepEqual(lines, [
    ["Template", "", "", "", "set system ntp server 192.0.2.1"],
    ["Template rule", "", "access", "", "set poe interface all"],
    ["Site", "HQ", "", "", "set snmp location HQ"],
    ["Site", "HQ", "", "", "set system ntp server 192.0.2.1"],
    ["Site rule", "HQ", "core", "", "set chassis aggregated-devices"],
    ["Device", "HQ", "", "sw-a", "set snmp location HQ"],
  ]);
  assert.match(result.summary, /^6 command line\(s\), 4 distinct, across 2 site\(s\) and 3 switch\(es\)$/);
  assert.match(result.filename, /^mist_switch_cli_all_sites_Acme_Corp_/);
  assert.match(result.files[0].name, /^mist_switch_cli_all_sites_Acme_Corp_.*\.txt$/);
});

test("By Switch and By Site count each level", async () => {
  stubMist(routes());
  const result = await run({});
  const sws = sheetNamed(result, "By Switch").rows;
  assert.deepEqual(sws.map((r) => r.switch), ["br-1", "sw-a", "sw-b"], "sites by name, then switches by name");
  const a = sws.find((r) => r.switch === "sw-a");
  assert.deepEqual([a.template, a.tplLines, a.siteLines, a.devLines, a.__style], ["Campus", 2, 3, 1, "yellow"]);
  assert.equal(a.mac, "aa:bb:cc:00:00:01");
  const hq = sheetNamed(result, "By Site").rows.find((r) => r.site === "HQ");
  assert.deepEqual([hq.siteLines, hq.siteRuleLines, hq.swWithCli, hq.devLines], [2, 1, 1, 1]);
});

test("Unique Commands merges levels and credits template lines to every site using it", async () => {
  stubMist(routes());
  const rows = sheetNamed(await run({}), "Unique Commands").rows;
  const ntp = rows.find((r) => r.command === "set system ntp server 192.0.2.1");
  assert.equal(ntp.levels, "Template, Site");
  assert.equal(ntp.siteCount, 2);
  assert.equal(ntp.sites, "Branch, HQ");
  assert.deepEqual(rows.map((r) => r.siteCount), [2, 2, 1, 1], "most widely used first");
  assert.deepEqual(rows.slice(0, 2).map((r) => r.command), ["set poe interface all", ntp.command], "ties by command");
  assert.equal(rows.find((r) => r.command === "set snmp location HQ").switchCount, 1);
  assert.deepEqual(sheetNamed(await run({}), "Templates").rows.map((r) => [r.rule, r.sites]), [["", 2], ["access", 2]]);
});

test("a cell past Excel's limit is clipped and marked", async () => {
  const huge = Array.from({ length: 2000 }, (_, i) => `set interfaces ge-0/0/${i} description ${"x".repeat(20)}`);
  stubMist(routes({ "/sites/s2/setting": { additional_config_cmds: huge } }));
  const br = sheetNamed(await run({}), "By Site").rows.find((r) => r.site === "Branch");
  assert.ok(br.siteCli.length < 32100, String(br.siteCli.length));
  assert.ok(br.siteCli.endsWith("…(truncated)"));
  assert.equal(br.siteLines, 2000, "the count is not clipped");
});

test("one site: only that site is queried", async () => {
  const calls = stubMist(routes());
  const result = await run({ allSites: false, siteId: "s2" });
  assert.deepEqual(sheetNamed(result, "By Switch").rows.map((r) => r.switch), ["br-1"]);
  assert.ok(!calls.some((c) => c.startsWith("/sites/s1/")));
  assert.match(result.filename, /^mist_switch_cli_Branch_Acme_Corp_/);
});

test("a failing site or missing templates is not fatal", async () => {
  stubMist(routes({
    "/sites/s1/setting": () => { throw new Error("boom"); },
    "/orgs/org-1/networktemplates": () => { throw new Error("nope"); },
  }));
  const result = await run({});
  assert.deepEqual(sheetNamed(result, "Failed Sites").rows.map((r) => r.site), ["HQ"]);
  assert.deepEqual(sheetNamed(result, "Templates").rows, []);
  assert.equal(sheetNamed(result, "By Site").rows[0].template, "t1", "falls back to the template id");
  assert.match(result.summary, /1 site\(s\) failed/);
});

test("no site picked is a clear error", async () => {
  stubMist(routes());
  await assert.rejects(run({ allSites: false }), /Pick a site/);
});
