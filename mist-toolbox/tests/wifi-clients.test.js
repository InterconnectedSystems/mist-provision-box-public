// The dynamic column union is the part worth pinning: a dropped column is a
// silently missing field in the export.

import { strict as assert } from "node:assert";
import test from "node:test";

import tool, { PREFERRED_COLUMNS, asClientList, flattenValue } from "../tools/wifi-clients.js";
import { sheetNamed, stubMist, testCtx } from "./helpers.mjs";

const SITES = [{ id: "s1", name: "HQ" }, { id: "s2", name: "Branch" }];

const HQ = [{
  mac: "aabbccddeeff", hostname: "laptop-1", username: "ada", ip: "10.0.0.5",
  ssid: "Corp", band: "5", proto: "ax", rssi: -58, snr: 34, last_seen: 1700000000,
  guest: { name: "Ada L", email: "ada@example.com", company: "Acme", authorized: true },
  airwatch: { compliant: true },
}];
const BRANCH = [{
  mac: "112233445566", hostname: "phone-9", band: "24", proto: "n",
  last_seen: 1700000500, custom_field: "only-here",
}];

const routes = (o = {}) => ({
  "/orgs/org-1/sites": SITES,
  "/sites/s1/stats/clients": HQ,
  "/sites/s2/stats/clients": BRANCH,
  ...o,
});

test("flattenValue JSON-encodes nested values and blanks nullish", () => {
  assert.equal(flattenValue(null), "");
  assert.equal(flattenValue(undefined), "");
  assert.equal(flattenValue({ a: 1 }), '{"a":1}');
  assert.equal(flattenValue([1, "x"]), '[1,"x"]');
  assert.equal(flattenValue("plain"), "plain");
  assert.equal(flattenValue(0), 0);
});

test("derived label columns match the Python's lookup tables", async () => {
  stubMist(routes());
  const result = await tool.run(testCtx());
  const rows = sheetNamed(result, "WiFi_Clients").rows;
  const hq = rows.find((r) => r.hostname === "laptop-1");
  assert.equal(hq.wifi_standard, "802.11ax");
  assert.equal(hq.band_label, "5 GHz");
  assert.equal(hq.last_seen_utc, "2023-11-14 22:13:20 UTC");
  const br = rows.find((r) => r.hostname === "phone-9");
  assert.equal(br.wifi_standard, "802.11n");
  assert.equal(br.band_label, "2.4 GHz");
});

test("guest sub-object is flattened into its own columns", async () => {
  stubMist(routes());
  const result = await tool.run(testCtx());
  const hq = sheetNamed(result, "WiFi_Clients").rows.find((r) => r.hostname === "laptop-1");
  assert.equal(hq.guest_name, "Ada L");
  assert.equal(hq.guest_email, "ada@example.com");
  assert.equal(hq.guest_company, "Acme");
  assert.equal(hq.guest_authorized, true);
});

test("columns are preferred-order first, then discovered fields alphabetically", async () => {
  stubMist(routes());
  const result = await tool.run(testCtx());
  const headers = sheetNamed(result, "WiFi_Clients").columns.map((c) => c.header);

  assert.equal(headers[0], "site_name");
  assert.equal(headers[1], "site_id");
  // Only preferred columns actually present appear, in preferred order.
  const present = headers.filter((h) => PREFERRED_COLUMNS.includes(h));
  const expectedOrder = PREFERRED_COLUMNS.filter((c) => present.includes(c));
  assert.deepEqual(present, expectedOrder);

  // Fields nothing in PREFERRED_COLUMNS knows about still make it in, sorted.
  const extras = headers.filter((h) => !PREFERRED_COLUMNS.includes(h));
  assert.deepEqual(extras, [...extras].sort(), "extras must be alphabetical");
  assert.ok(extras.includes("custom_field"), "a field only one site reported is still a column");
  assert.ok(extras.includes("airwatch"), "a nested field becomes a JSON column");
  assert.ok(extras.includes("guest_email"));
});

test("site summary carries a TOTAL row", async () => {
  stubMist(routes());
  const result = await tool.run(testCtx());
  const rows = sheetNamed(result, "Site_Summary").rows;
  const totalRow = rows[rows.length - 1];
  assert.equal(totalRow.site_name, "TOTAL");
  assert.equal(totalRow.client_count, 2);
});

test("the clients sheet freezes the header and both site columns", async () => {
  stubMist(routes());
  const result = await tool.run(testCtx());
  assert.deepEqual(sheetNamed(result, "WiFi_Clients").freeze, { row: 1, col: 2 });
});

test("an org with clients nowhere still produces a readable sheet", async () => {
  stubMist(routes({ "/sites/s1/stats/clients": [], "/sites/s2/stats/clients": [] }));
  const result = await tool.run(testCtx());
  const s = sheetNamed(result, "WiFi_Clients");
  assert.deepEqual(s.columns.map((c) => c.header), ["site_name", "note"]);
  assert.equal(s.rows[0].note, "No Wi-Fi clients found");
});

test("asClientList unwraps every shape the endpoint returns", () => {
  assert.deepEqual(asClientList([{ mac: "a" }]), [{ mac: "a" }], "a bare list passes through");
  assert.deepEqual(asClientList({ clients: [{ mac: "b" }] }), [{ mac: "b" }]);
  assert.deepEqual(asClientList({ results: [{ mac: "c" }] }), [{ mac: "c" }]);
  // getAll wraps an unrecognised object as [object]; unwrap that too.
  assert.deepEqual(asClientList([{ clients: [{ mac: "d" }] }]), [{ mac: "d" }]);
  assert.deepEqual(asClientList(null), []);
});

test("the {clients:[]} response shape is accepted", async () => {
  stubMist(routes({ "/sites/s2/stats/clients": { clients: BRANCH } }));
  const result = await tool.run(testCtx());
  assert.ok(sheetNamed(result, "WiFi_Clients").rows.some((r) => r.hostname === "phone-9"));
});

test("the file name is timestamped, unlike the Python's fixed name", async () => {
  stubMist(routes());
  const result = await tool.run(testCtx());
  assert.match(result.filename, /^mist_wifi_clients_Acme_Corp_\d{8}_\d{6}\.xlsx$/);
});

test("one site: only that site's clients", async () => {
  const calls = stubMist(routes());
  const result = await tool.run(testCtx({ params: { allSites: false, siteId: "s1" } }));
  const rows = sheetNamed(result, "WiFi_Clients").rows;
  assert.ok(rows.length && rows.every((r) => r.site_name === "HQ"));
  assert.ok(!calls.some((c) => c.startsWith("/sites/s2/")));
  assert.match(result.filename, /^mist_wifi_clients_Acme_Corp_HQ_/);
});
