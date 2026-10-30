// SSID Banned / Approved Clients: MAC parsing, client attributes, the requests a
// push would make (one site, the org list, each site's list, WLAN blocking),
// Mist's list limits, and that nothing is sent for a token that cannot make
// changes or a plan with errors. The screen itself is drawn in the browser;
// this covers its logic.

import { strict as assert } from "node:assert";
import test from "node:test";

import tool, {
  LISTS, ORG_BANNED_MAX, WLAN_ENFORCED_MAX, normMac, normalizeClient, parseMacs, planCalls, pushPlan,
} from "../tools/ssid-client-lists.js";
import { validateTool } from "../tools/registry.js";
import { stubMist, testCtx } from "./helpers.mjs";

const SITE = { id: "s1", name: "HQ" };
const siteQuery = { scope: "site", siteId: "s1", siteName: "HQ", ssid: "Demo-Guest" };
const orgQuery = { scope: "org", siteId: null, siteName: "Demo Org", ssid: "Demo-Guest" };
const NAMES = { s1: "HQ", s2: "Branch", s3: "Annex" };
const bySite = (o) => new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]));
const macs = (n, prefix = "0200000") => Array.from({ length: n }, (_, i) => prefix + i.toString(16).padStart(5, "0"));

test("the tool draws its own screen, declares that it makes changes and is valid", () => {
  assert.equal(validateTool(tool, "ssid-client-lists.js"), tool);
  assert.equal(typeof tool.mount, "function");
  assert.equal(tool.writes, true);
  assert.equal(tool.scope, undefined, "no generated site picker: the screen has its own");
  assert.equal(tool.params, undefined);
  assert.match(tool.notice, /personal data/);
  assert.deepEqual(Object.keys(LISTS), ["banned", "approved"]);
  assert.equal(LISTS.banned.path, "blacklist");
  assert.equal(LISTS.approved.path, "whitelist");
});

test("MACs are normalised from any common notation, and the rest is reported", () => {
  assert.equal(normMac("AA:BB:CC:00:11:22"), "aabbcc001122");
  assert.equal(normMac("aabb.cc00.1122"), "aabbcc001122");
  assert.equal(normMac("aa-bb-cc-00-11-22"), "aabbcc001122");
  assert.equal(normMac("aabbcc0011"), null);
  assert.equal(normMac(undefined), null);
  const { ok, bad } = parseMacs("AA:BB:CC:00:11:22, aabbcc001122;\n02-00-00-00-00-01 nope");
  assert.deepEqual(ok, ["aabbcc001122", "020000000001"], "duplicates fold together");
  assert.deepEqual(bad, ["nope"]);
});

test("a client's attributes: random MACs, bands, booleans and missing values", () => {
  const c = normalizeClient({ mac: "02:00:00:00:00:01", hostname: "demo-phone", band: "5", is_guest: true, family: "" }, SITE);
  assert.equal(c.mac, "020000000001");
  assert.equal(c.siteId, "s1");
  assert.equal(c.attrs._random, "Randomised (private)");
  assert.equal(c.attrs.band, "5 GHz");
  assert.equal(c.attrs.is_guest, "Yes");
  assert.equal(c.attrs.family, "(unknown)");
  assert.equal(c.attrs._site, "HQ");
  assert.equal(normalizeClient({ mac: "00:11:22:33:44:55" }, SITE).attrs._random, "Hardware (universal)");
  assert.equal(normalizeClient({ mac: "junk" }, SITE), null);
});

test("one site: one POST that replaces that site's list with the selection plus extras", () => {
  const p = planCalls({
    list: "banned", target: "site", query: siteQuery, orgId: "org-1",
    extraText: "02:00:00:00:00:09 bogus", bySite: bySite({ s1: ["020000000001", "020000000002"] }),
  });
  assert.deepEqual(p.errors, []);
  assert.equal(p.calls.length, 1);
  assert.deepEqual(
    { verb: p.calls[0].verb, path: p.calls[0].path, body: p.calls[0].body },
    { verb: "POST", path: "/sites/s1/setting/blacklist", body: { macs: ["020000000009", "020000000001", "020000000002"] } },
  );
  assert.ok(p.warnings.some((w) => /bogus/.test(w)), "the bad extra is reported");
});

test("approved clients in org mode go to each site's own list, sorted by site name", () => {
  const p = planCalls({
    list: "approved", target: "sites", query: orgQuery, orgId: "org-1",
    extraText: "020000000099",
    bySite: bySite({ s1: ["020000000001"], s2: ["020000000002", "020000000003"] }),
    siteName: (id) => NAMES[id],
  });
  assert.deepEqual(p.calls.map((c) => c.path), ["/sites/s2/setting/whitelist", "/sites/s1/setting/whitelist"]);
  assert.deepEqual(p.calls[0].body.macs, ["020000000002", "020000000003", "020000000099"]);
  assert.ok(p.calls.every((c) => c.body.macs.includes("020000000099")), "extras go to every site");
  assert.ok(!p.calls.some((c) => c.path.startsWith("/orgs/")), "Mist has no org approved list");
});

test("the org banned list: one POST, refused above Mist's limit", () => {
  const ok = planCalls({ list: "banned", target: "org", query: orgQuery, orgId: "org-1", bySite: bySite({ s1: macs(3) }) });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.calls[0].path, "/orgs/org-1/setting/blacklist");

  const big = planCalls({
    list: "banned", target: "org", query: orgQuery, orgId: "org-1",
    bySite: bySite({ s1: macs(ORG_BANNED_MAX), s2: macs(1, "0200001") }),
  });
  assert.equal(big.errors.length, 1);
  assert.match(big.errors[0], /at most 1000/);
});

test("more banned MACs than a WLAN enforces is a warning, not an error", () => {
  const p = planCalls({ list: "banned", target: "site", query: siteQuery, orgId: "org-1", bySite: bySite({ s1: macs(WLAN_ENFORCED_MAX + 1) }) });
  assert.deepEqual(p.errors, []);
  assert.ok(p.warnings.some((w) => /first 256/.test(w)));
  const approved = planCalls({ list: "approved", target: "site", query: siteQuery, orgId: "org-1", bySite: bySite({ s1: macs(WLAN_ENFORCED_MAX + 1) }) });
  assert.ok(!approved.warnings.some((w) => /first 256/.test(w)), "the limit is about banned clients only");
});

test("nothing selected is an error", () => {
  assert.equal(planCalls({ list: "banned", target: "site", query: siteQuery, orgId: "org-1", bySite: new Map() }).errors.length, 1);
  assert.equal(planCalls({ list: "approved", target: "sites", query: orgQuery, orgId: "org-1", bySite: new Map() }).errors.length, 1);
});

test("banned-client blocking is turned on only where it is off, and only for the banned list", () => {
  const wlans = [
    { where: "site", siteId: "s1", siteName: "HQ", id: "w1", ssid: "Demo-Guest", blocked: false },
    { where: "org", id: "w2", ssid: "Demo-Guest", blocked: false },
    { where: "site", siteId: "s2", siteName: "Branch", id: "w3", ssid: "Demo-Guest", blocked: true },
  ];
  const p = planCalls({ list: "banned", target: "site", query: siteQuery, orgId: "org-1", bySite: bySite({ s1: macs(1) }), wlans });
  const puts = p.calls.filter((c) => c.kind === "wlan");
  assert.deepEqual(puts.map((c) => `${c.verb} ${c.path}`), ["PUT /sites/s1/wlans/w1", "PUT /orgs/org-1/wlans/w2"]);
  assert.deepEqual(puts[0].body, { block_blacklist_clients: true });
  const approved = planCalls({ list: "approved", target: "site", query: siteQuery, orgId: "org-1", bySite: bySite({ s1: macs(1) }), wlans });
  assert.ok(!approved.calls.some((c) => c.kind === "wlan"));
});

test("names in the change descriptions are escaped", () => {
  const p = planCalls({
    list: "banned", target: "site", query: { ...siteQuery, siteName: "<b>HQ</b>" }, orgId: "org-1",
    bySite: bySite({ s1: macs(1) }), esc: (s) => String(s).replace(/</g, "&lt;"),
  });
  assert.ok(!p.calls[0].what.includes("<b>"));
});

test("a cancelled query and unreadable sites are flagged", () => {
  const p = planCalls({
    list: "banned", target: "site", query: { ...siteQuery, cancelled: true }, orgId: "org-1",
    bySite: bySite({ s1: macs(1) }), failedSites: 2,
  });
  assert.ok(p.warnings.some((w) => /cancelled/.test(w)));
  assert.ok(p.warnings.some((w) => /2 site\(s\) could not be read/.test(w)));
});

test("push: nothing is sent for a token that cannot make changes", async () => {
  stubMist({});
  const ctx = testCtx({ role: "read" });
  const p = planCalls({ list: "banned", target: "site", query: siteQuery, orgId: "org-1", bySite: bySite({ s1: macs(1) }) });
  await assert.rejects(pushPlan(ctx, p), /cannot make changes.*Nothing was sent/);
  await assert.rejects(pushPlan({ ...ctx, access: undefined }, p), /permission unknown/, "unknown access is refused too");
  assert.deepEqual(ctx.writes, []);
});

test("push: nothing is sent for a plan with errors", async () => {
  stubMist({});
  const ctx = testCtx({ role: "admin" });
  const p = planCalls({ list: "banned", target: "site", query: siteQuery, orgId: "org-1", bySite: new Map() });
  await assert.rejects(pushPlan(ctx, p), /Nothing was sent/);
  assert.deepEqual(ctx.writes, []);
});

test("push: every request is sent in order, and one failure does not stop the rest", async () => {
  const calls = stubMist({ "/sites/s1/setting/blacklist": {}, "/sites/s1/wlans/w1": {} });
  const ctx = testCtx({ role: "write" });
  const wlan = { where: "site", siteId: "s1", siteName: "HQ", id: "w1", ssid: "Demo-Guest", blocked: false };
  const p = planCalls({
    list: "banned", target: "sites", query: orgQuery, orgId: "org-1",
    bySite: bySite({ s1: macs(2), s2: macs(1) }), siteName: (id) => NAMES[id], wlans: [wlan],
  });
  const steps = [];
  const results = await pushPlan(ctx, p, (i, n) => steps.push(`${i}/${n}`));
  assert.deepEqual(ctx.writes.map((w) => `${w.method} ${w.path}`), [
    "POST /sites/s2/setting/blacklist", "POST /sites/s1/setting/blacklist", "PUT /sites/s1/wlans/w1",
  ]);
  assert.deepEqual(steps, ["0/3", "1/3", "2/3"]);
  assert.deepEqual(results.map((r) => r.ok), [false, true, true], "s2 has no route here, so it fails alone");
  assert.equal(wlan.blocked, true, "a WLAN that was switched on is remembered");
  assert.equal(calls.length, 3);
});
