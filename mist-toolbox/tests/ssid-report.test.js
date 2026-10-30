// End-to-end for the first ported tool: stubbed Mist in, sheet specs out.
// The row shaping is checked against mist_ssid_report.py's describe_* helpers.

import { strict as assert } from "node:assert";
import test from "node:test";

import tool, { describeAuth, describeVlan, wlanSource } from "../tools/ssid-report.js";
import { sheetNamed, stubMist, testCtx } from "./helpers.mjs";

const SITES = [{ id: "site-1", name: "HQ" }, { id: "site-2", name: "Branch" }];
const TEMPLATES = [{ id: "tpl-1", name: "Corp Template" }];

const HQ_WLANS = [
  {
    id: "w1", ssid: "Corp-WiFi", enabled: true, hide_ssid: false,
    auth: { type: "wpa2", pairwise: ["ccmp", "tkip"] },
    vlan_enabled: true, vlan_id: 100, bands: ["5", "6"],
    interface: "all", template_id: "tpl-1",
  },
  {
    id: "w2", ssid: "Guest", enabled: false, hide_ssid: true,
    auth: { type: "open" }, vlan_enabled: false, band: "2.4",
    site_id: "site-1",
  },
];
const BRANCH_WLANS = [
  {
    id: "w3", ssid: "Branch-Net", hide_ssid: false,
    auth: { type: "psk" }, vlan_enabled: true, vlan_ids: [10, 20, 30],
    bands: ["2.4", "5"],
  },
];

function routes(overrides = {}) {
  return {
    "/orgs/org-1/templates": TEMPLATES,
    "/orgs/org-1/sites": SITES,
    "/sites/site-1/wlans/derived": HQ_WLANS,
    "/sites/site-2/wlans/derived": BRANCH_WLANS,
    ...overrides,
  };
}

test("produces the three sheets mist_ssid_report.py produced", async () => {
  stubMist(routes());
  const result = await tool.run(testCtx());
  assert.deepEqual(result.sheets.map((s) => s.name), ["SSIDs by Site", "Site Summary", "Info"]);
  assert.match(result.filename, /^mist_ssids_Acme_Corp_\d{8}_\d{6}\.xlsx$/);
});

test("detail rows carry the derived SSIDs with their source", async () => {
  stubMist(routes());
  const result = await tool.run(testCtx());
  const rows = sheetNamed(result, "SSIDs by Site").rows;
  assert.equal(rows.length, 3);

  // Sorted by site then SSID: Branch-Net, then HQ's Corp-WiFi and Guest.
  const branch = rows.find((r) => r.ssid === "Branch-Net");
  assert.equal(branch.site, "Branch");
  assert.equal(branch.vlan, "10,20,30");
  assert.equal(branch.bands, "2.4, 5");
  assert.equal(branch.source, "Org", "no template_id and no site_id means org-level");

  const corp = rows.find((r) => r.ssid === "Corp-WiFi");
  assert.equal(corp.auth, "wpa2 (ccmp/tkip)");
  assert.equal(corp.vlan, "100");
  assert.equal(corp.enabled, "Yes");
  assert.equal(corp.hidden, "No");
  assert.equal(corp.source, "Org template: Corp Template", "template id resolves to its name");

  const guest = rows.find((r) => r.ssid === "Guest");
  assert.equal(guest.enabled, "No");
  assert.equal(guest.hidden, "Yes");
  assert.equal(guest.vlan, "untagged");
  assert.equal(guest.bands, "2.4", "a single `band` becomes the bands list");
  assert.equal(guest.source, "Site");
});

test("site summary counts enabled and disabled separately", async () => {
  stubMist(routes());
  const result = await tool.run(testCtx());
  const rows = sheetNamed(result, "Site Summary").rows;
  const hq = rows.find((r) => r.site === "HQ");
  assert.deepEqual(
    { count: hq.count, enabled: hq.enabled, disabled: hq.disabled },
    { count: 2, enabled: 1, disabled: 1 },
  );
});

test("a site that errors is recorded on the Info sheet, not fatal", async () => {
  stubMist(routes({ "/sites/site-2/wlans/derived": () => { throw new Error("boom"); } }));
  const ctx = testCtx();
  const result = await tool.run(ctx);
  assert.equal(sheetNamed(result, "SSIDs by Site").rows.length, 2, "HQ still reported");
  const info = sheetNamed(result, "Info").rows.map((r) => (Array.isArray(r) ? r.join(":") : ""));
  assert.ok(info.some((r) => r.startsWith("Sites with errors")));
  assert.ok(info.some((r) => r.startsWith("Branch:")));
  assert.match(result.summary, /1 site\(s\) unreadable/);
});

test("missing template read access degrades instead of failing", async () => {
  stubMist(routes({ "/orgs/org-1/templates": () => { throw new Error("403"); } }));
  const result = await tool.run(testCtx());
  const corp = sheetNamed(result, "SSIDs by Site").rows.find((r) => r.ssid === "Corp-WiFi");
  assert.equal(corp.source, "Org template: tpl-1", "falls back to the raw template id");
});

test("skipEmpty omits SSID-less sites from the detail sheet only", async () => {
  stubMist(routes({ "/sites/site-2/wlans/derived": [] }));
  const result = await tool.run(testCtx({ params: { skipEmpty: true } }));
  assert.equal(sheetNamed(result, "SSIDs by Site").rows.length, 2);
  assert.equal(sheetNamed(result, "Site Summary").rows.length, 2, "summary keeps every site");
});

test("the workbook actually builds", async () => {
  stubMist(routes());
  const ctx = testCtx();
  const result = await tool.run(ctx);
  const blob = await ctx.xlsx.workbook(result.sheets);
  assert.ok(blob.size > 2000, "a three-sheet workbook should be more than a stub");
  assert.equal(blob.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
});

test("describe_* helpers match the Python", () => {
  assert.equal(describeVlan({ vlan_enabled: false }), "untagged");
  assert.equal(describeVlan({ vlan_enabled: true, vlan_ids: [1, 2] }), "1,2");
  assert.equal(describeVlan({ vlan_enabled: true, vlan_id: 7 }), "7");
  assert.equal(describeVlan({ vlan_enabled: true }), "dynamic");
  assert.equal(describeAuth({ auth: { type: "wpa2", pairwise: ["ccmp"] } }), "wpa2 (ccmp)");
  assert.equal(describeAuth({ auth: { type: "open" } }), "open");
  assert.equal(describeAuth({}), "");
  assert.equal(wlanSource({ template_id: "t" }, { t: "Tpl" }), "Org template: Tpl");
  assert.equal(wlanSource({ template_id: "t" }, {}), "Org template: t");
  assert.equal(wlanSource({ site_id: "s" }, {}), "Site");
  assert.equal(wlanSource({}, {}), "Org");
});

test("one site: only that site is queried and reported", async () => {
  const calls = stubMist(routes());
  const result = await tool.run(testCtx({ params: { allSites: false, siteId: "site-2" } }));
  assert.deepEqual(sheetNamed(result, "SSIDs by Site").rows.map((r) => r.ssid), ["Branch-Net"]);
  assert.deepEqual(sheetNamed(result, "Site Summary").rows.map((r) => r.site), ["Branch"]);
  assert.ok(!calls.some((c) => c.startsWith("/sites/site-1/")), "HQ is never fetched");
  assert.match(result.filename, /^mist_ssids_Acme_Corp_Branch_/);
  const info = sheetNamed(result, "Info").rows;
  assert.ok(info.some((r) => Array.isArray(r) && r[0] === "Scope" && r[1] === "Site: Branch"));
});
