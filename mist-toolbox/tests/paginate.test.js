// The pagination rules are the part of the port most likely to silently
// truncate a report, so they are pinned here against a stubbed fetch.

import { strict as assert } from "node:assert";
import test from "node:test";

import { encodeParams, getAll, resolveNext, searchAll } from "../lib/paginate.js";

const HOST = "api.gc2.mist.com";
const CTX = { host: HOST, token: "t".repeat(20) };

/** Install a fetch stub that answers from `handler(url)`. */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    calls.push(u.pathname + u.search);
    const { body, headers = {} } = handler(u) || {};
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => headers[k] ?? headers[k.toLowerCase()] ?? null },
      text: async () => JSON.stringify(body),
    };
  };
  return calls;
}

const rows = (n, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ mac: `aa${String(from + i).padStart(6, "0")}` }));

test("getAll keeps paging while X-Page-Total exceeds what was collected", async () => {
  // Mist's real behaviour: 100 rows per page while echoing limit=1000.
  const pages = { 1: rows(100, 0), 2: rows(100, 100), 3: rows(50, 200) };
  const calls = stubFetch((u) => ({
    body: pages[u.searchParams.get("page")] || [],
    headers: { "X-Page-Total": "250" },
  }));

  const out = await getAll(CTX, "/orgs/o1/devices");
  assert.equal(out.length, 250, "a short page must not end the walk");
  assert.equal(calls.length, 3);
  assert.match(calls[0], /limit=1000/);
});

test("getAll stops on a short page when there is no X-Page-Total", async () => {
  const pages = { 1: rows(1000, 0), 2: rows(7, 1000) };
  stubFetch((u) => ({ body: pages[u.searchParams.get("page")] || [] }));
  const out = await getAll(CTX, "/orgs/o1/sites");
  assert.equal(out.length, 1007);
});

test("getAll stops when a page repeats instead of looping forever", async () => {
  const calls = stubFetch(() => ({ body: rows(100, 0), headers: { "X-Page-Total": "99999" } }));
  const out = await getAll(CTX, "/orgs/o1/devices");
  assert.equal(out.length, 100);
  assert.equal(calls.length, 2, "one page, then the repeat that stops it");
});

test("getAll hands off to searchAll when the endpoint answers in search shape", async () => {
  const calls = stubFetch((u) => {
    if (u.searchParams.get("search_after")) {
      return { body: { results: rows(2, 2), total: 4, next: null } };
    }
    return {
      body: {
        results: rows(2, 0),
        total: 4,
        next: "/api/v1/orgs/o1/stats/ports/search?limit=1000&search_after=cursor42",
      },
    };
  });
  const out = await getAll(CTX, "/orgs/o1/stats/ports/search", { device_type: "switch" });
  assert.equal(out.length, 4);
  assert.ok(calls.some((c) => c.includes("search_after=cursor42")), "cursor must be followed");
  assert.ok(!calls.some((c) => c.includes("/api/v1/api/v1")), "/api/v1 must not be doubled");
});

test("searchAll stops once `total` rows are in, with distinct cursors", async () => {
  let n = 0;
  const calls = stubFetch(() => {
    n += 1;
    // A fresh cursor each time, so `total` is what ends the walk rather than
    // the repeated-cursor guard exercised in the next test.
    return { body: { results: rows(2, n * 2), total: 6, next: `/api/v1/x/search?search_after=c${n}` } };
  });
  const out = await searchAll(CTX, "/x/search");
  assert.equal(out.length, 6, "total ends the walk");
  assert.equal(calls.length, 3);
  assert.ok(calls[1].includes("search_after=c1"), "each cursor is followed in turn");
});

test("searchAll breaks on a repeated cursor even without a total", async () => {
  stubFetch(() => ({ body: { results: rows(2), next: "/api/v1/x/search?search_after=same" } }));
  const out = await searchAll(CTX, "/x/search");
  assert.equal(out.length, 4, "first page, the cursor page, then the repeat stops it");
});

test("resolveNext strips the /api/v1 prefix and keeps the query", () => {
  assert.equal(
    resolveNext(HOST, "/api/v1/orgs/o1/stats/ports/search?limit=1000&search_after=abc"),
    "/orgs/o1/stats/ports/search?limit=1000&search_after=abc",
  );
  assert.equal(
    resolveNext(HOST, `https://${HOST}/api/v1/x/search?search_after=abc`),
    "/x/search?search_after=abc",
  );
  assert.equal(resolveNext(HOST, "/orgs/o1/x?page=2"), "/orgs/o1/x?page=2");
});

test("resolveNext refuses a cursor pointing at another host", () => {
  assert.throws(
    () => resolveNext(HOST, "https://evil.example.com/api/v1/x/search?search_after=abc"),
    /different host/,
  );
});

test("encodeParams sends Mist's lowercase booleans and drops nullish", () => {
  assert.deepEqual(
    encodeParams({ vc: true, unassigned: false, type: "switch", skip: null, gone: undefined }),
    { vc: "true", unassigned: "false", type: "switch" },
  );
});
