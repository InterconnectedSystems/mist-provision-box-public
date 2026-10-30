// BGP Sessions, added as written: switch vs WAN-edge split, SSR/SRX peer-path
// classing, newest-sample dedupe, scope, and a failing call that is not fatal.

import { strict as assert } from "node:assert";
import test from "node:test";

import tool from "../tools/bgp-sessions.js";
import { sheetNamed, stubMist, testCtx } from "./helpers.mjs";

const SITES = [{ id: "s1", name: "HQ" }, { id: "s2", name: "Branch" }];

const SWITCHES = [
  { mac: "aabbcc000001", name: "core-sw", model: "EX4400-48P", site_id: "s1" },
  { mac: "aabbcc000002", name: "br-sw", model: "EX2300-24P", site_id: "s2" },
];
const GATEWAYS = [
  { mac: "aabbcc0000a1", name: "hq-ssr", model: "SSR130", site_id: "s1" },
  { mac: "aabbcc0000a2", name: "br-srx", model: "SRX320", site_id: "s2" },
];

const bgp = (o) => ({ vrf_name: "default", local_as: 65000, neighbor_as: 65001, timestamp: 100, ...o });
const BGP = [
  bgp({ mac: "aabbcc000001", site_id: "s1", neighbor: "10.0.0.2", state: "established", uptime: 3 * 86400 }),
  bgp({ mac: "aabbcc000002", site_id: "s2", neighbor: "10.0.1.2", state: "idle", up: false }),
  bgp({ mac: "aabbcc0000a1", site_id: "s1", neighbor: "192.0.2.1", state: "established", uptime: 90000 }),
  // Older sample of the same session: the newest (above) must win.
  bgp({ mac: "aabbcc0000a1", site_id: "s1", neighbor: "192.0.2.1", state: "idle", timestamp: 50 }),
];

const PATHS = [
  { mac: "aabbcc0000a1", site_id: "s1", port_id: "ge-0/0/0", peer_mac: "aabbcc0000a2", peer_site_id: "s2",
    type: "svr", up: true, loss: 0, mos: 4.4 },
  { mac: "aabbcc0000a2", site_id: "s2", port_id: "ge-0/0/1", peer_mac: "aabbcc0000a1", peer_site_id: "s1",
    type: "ipsec", up: false },
];

const routes = (o = {}) => ({
  "/orgs/org-1/sites": SITES,
  "/orgs/org-1/stats/devices": (u) => (u.searchParams.get("type") === "gateway" ? GATEWAYS : SWITCHES),
  "/orgs/org-1/stats/bgp_peers/search": (u) => ({
    results: BGP.filter((r) => !u.searchParams.get("site_id") || r.site_id === u.searchParams.get("site_id")),
  }),
  "/orgs/org-1/stats/vpn_peers/search": (u) => ({
    results: PATHS.filter((r) => !u.searchParams.get("site_id") || r.site_id === u.searchParams.get("site_id")),
  }),
  ...o,
});

const run = (params) => tool.run(testCtx({ params: { allSites: true, ...params } }));

test("sessions split into switch and WAN edge by device type, newest sample wins", async () => {
  stubMist(routes());
  const result = await run({});
  const sw = sheetNamed(result, "Switch BGP").rows;
  const wan = sheetNamed(result, "WAN edge BGP").rows;
  assert.deepEqual(sw.map((r) => r.device), ["br-sw", "core-sw"], "idle session sorts first");
  assert.deepEqual(sw.map((r) => r.stateLabel), ["Idle", "Established"]);
  assert.deepEqual(wan.map((r) => [r.device, r.stateLabel]), [["hq-ssr", "Established"]]);
  assert.equal(sw[0].__style, "red");
  assert.equal(wan[0].__style, "green");
  assert.match(result.summary, /^2 of 3 BGP sessions up · 1 of 2 peer paths up/);
  assert.match(result.filename, /^bgp_sessions_/);
});

test("peer paths are classed SSR or SRX, and problems are collected", async () => {
  stubMist(routes());
  const result = await run({});
  const paths = sheetNamed(result, "Peer paths").rows;
  assert.deepEqual(Object.fromEntries(paths.map((r) => [r.device, r.kind])),
    { "hq-ssr": "SSR peer path", "br-srx": "SRX IPsec" });
  assert.equal(paths[0].device, "br-srx", "down path sorts first");
  assert.equal(paths.find((r) => r.device === "hq-ssr").peerSite, "Branch");
  const problems = sheetNamed(result, "Problems").rows;
  assert.deepEqual(problems.map((r) => r.type).sort(), ["Peer path", "Switch BGP"]);
  const total = sheetNamed(result, "By site").rows.at(-1);
  assert.deepEqual({ ...total, __style: undefined },
    { site: "Total", switchBgp: 2, switchDown: 1, wanBgp: 1, wanDown: 0, paths: 2, pathsDown: 1, __style: undefined });
});

test("one site: the search is filtered to that site", async () => {
  const calls = stubMist(routes());
  const result = await run({ allSites: false, siteId: "s2" });
  assert.ok(calls.some((c) => c.startsWith("/orgs/org-1/stats/bgp_peers/search") && c.includes("site_id=s2")));
  assert.deepEqual(sheetNamed(result, "Switch BGP").rows.map((r) => r.device), ["br-sw"]);
  assert.equal(sheetNamed(result, "WAN edge BGP").rows.length, 0);
});

test("unticked sections are not queried or exported", async () => {
  const calls = stubMist(routes());
  const result = await run({ paths: false, wan: false });
  assert.ok(!calls.some((c) => c.includes("vpn_peers")));
  assert.deepEqual(result.sheets.map((s) => s.name), ["Switch BGP", "Problems", "By site"]);
  await assert.rejects(run({ switches: false, wan: false, paths: false }), /Pick at least one/);
});

test("a failing call is reported, not fatal, unless every source failed", async () => {
  const boom = () => { throw new Error("boom"); };
  stubMist(routes({ "/orgs/org-1/stats/vpn_peers/search": boom }));
  const result = await run({});
  assert.equal(sheetNamed(result, "Peer paths").rows.length, 0);
  assert.equal(sheetNamed(result, "Switch BGP").rows.length, 2);
  assert.match(result.summary, /1 call failed/);

  stubMist(routes({ "/orgs/org-1/stats/vpn_peers/search": boom, "/orgs/org-1/stats/bgp_peers/search": boom }));
  await assert.rejects(run({}));
});
