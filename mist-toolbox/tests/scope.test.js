// Site / org scope: the shared fields, the site resolution, the card chips,
// and listSites paging past Mist's first page.

import { strict as assert } from "node:assert";
import test from "node:test";

import { effectiveParams, resolveSites, scopeChip, SCOPE_PARAMS } from "../lib/scope.js";
import { listSites } from "../mist.js";
import { BUILTIN_TOOLS, validateTool } from "../tools/registry.js";
import { HOST } from "./helpers.mjs";

const SITES = [{ id: "b", name: "branch" }, { id: "a", name: "HQ" }, { name: "no id" }];
const getAll = async (path) => {
  assert.equal(path, "/orgs/org-1/sites");
  return SITES;
};

test("all sites: every site with an id, sorted by name", async () => {
  const r = await resolveSites({ getAll, orgId: "org-1", orgName: "Acme", params: { allSites: true } });
  assert.deepEqual(r.sites.map((s) => s.name), ["branch", "HQ"]);
  assert.equal(r.all, true);
  assert.equal(r.label, "all 2 sites");
  assert.equal(r.fileLabel, "Acme");
});

test("no params at all means the whole org, as before scope existed", async () => {
  const r = await resolveSites({ getAll, orgId: "org-1", orgName: "Acme", params: {} });
  assert.equal(r.all, true);
});

test("one site: just that site, but every site in orgSites", async () => {
  const r = await resolveSites({ getAll, orgId: "org-1", orgName: "Acme", params: { allSites: false, siteId: "a" } });
  assert.deepEqual(r.sites.map((s) => s.id), ["a"]);
  assert.equal(r.orgSites.length, 2);
  assert.equal(r.label, "HQ");
  assert.equal(r.fileLabel, "Acme_HQ");
});

test("a missing or unknown site is a clear error", async () => {
  await assert.rejects(resolveSites({ getAll, orgId: "org-1", params: { allSites: false } }), /Pick a site/);
  await assert.rejects(resolveSites({ getAll, orgId: "org-1", params: { allSites: false, siteId: "zz" } }), /no longer in this org/);
  await assert.rejects(resolveSites({ getAll: async () => [], orgId: "org-1", params: {} }), /no sites/);
});

test("scoped tools get the two fields first; others are untouched", () => {
  const own = [{ id: "x", type: "checkbox" }];
  assert.deepEqual(effectiveParams({ scope: "site", params: own }).map((p) => p.id), ["allSites", "siteId", "x"]);
  assert.deepEqual(effectiveParams({ params: own }), own);
  assert.equal(SCOPE_PARAMS[0].default, true, "the whole org by default");
});

test("every built-in tool card says what level it works at", async () => {
  const chips = {};
  for (const file of BUILTIN_TOOLS) {
    const tool = (await import(`../tools/${file}`)).default;
    chips[tool.id] = scopeChip(tool);
  }
  assert.deepEqual(chips, {
    "ap-site-upgrade": "Site · Org",
    "bgp-sessions": "Site · Org",
    "client-wifi-phy": "Site · Client",
    "disconnect-console": "Site · Client",
    "ip-blocks": "Site · Org",
    "port-inventory": "Site · Org",
    "ssid-client-lists": "Site · Org",
    "ssid-report": "Site · Org",
    "site-alarms": "Site · Org",            // its own checkbox + dropdown count
    "ssr-pre-post": "SSR Conductor",
    "switch-additional-cli": "Site · Org",
    "switch-configs": "Site · Org",
    "switch-psu-status": "Site · Org",
    "switch-report": "Site · Org",
    "switch-site-upgrade": "Site · Org",
    "wifi-clients": "Site · Org",
  });
  assert.equal(scopeChip({ needs: { org: true } }), "Org");
});

test("the registry polices scope", () => {
  const ok = { id: "a", name: "A", description: "d", run() {} };
  assert.equal(validateTool({ ...ok, scope: "site" }, "a.js").scope, "site");
  assert.throws(() => validateTool({ ...ok, scope: "org" }, "a.js"), /can only be "site"/);
  assert.throws(() => validateTool({ ...ok, scope: "site", params: [{ id: "siteId" }] }, "a.js"),
    /drawn by the toolbox/);
  // An unscoped tool may still draw its own (Site Alarms does).
  assert.ok(validateTool({ ...ok, params: [{ id: "allSites" }, { id: "siteId" }] }, "a.js"));
});

test("listSites pages past Mist's first page", async () => {
  const all = Array.from({ length: 250 }, (_, i) => ({ id: `s${i}`, name: `Site ${String(i).padStart(3, "0")}` }));
  const pages = [];
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    const page = Number(u.searchParams.get("page"));
    pages.push(page);
    // Mist echoes limit=1000 but serves 100 rows; only X-Page-Total is honest.
    const body = all.slice((page - 1) * 100, page * 100);
    return {
      ok: true, status: 200,
      headers: { get: (h) => (h === "X-Page-Total" ? "250" : null) },
      text: async () => JSON.stringify(body),
    };
  };
  const sites = await listSites("t".repeat(20), HOST, "org-1");
  assert.equal(sites.length, 250);
  assert.deepEqual(pages, [1, 2, 3]);
  assert.equal(sites[0].name, "Site 000");
});
