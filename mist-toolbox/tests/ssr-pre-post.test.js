// The SSR tool's pure parts: the diff engine, the Conductor request layer and
// the asset walk. The mounted UI is exercised by hand (see README).

import { strict as assert } from "node:assert";
import test from "node:test";

import { SequenceMatcher, charDiff, computeChanges, flatten } from "../lib/diff.js";
import tool, {
  CHECKS, authenticate, collectCheck, normalizeBaseUrl, routerNodesFromAssets,
} from "../ssr/ssr-pre-post.js";

const BASE = "https://conductor.example.com";

/** Answer Conductor requests from a routing table; records method and body. */
function stubConductor(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({
      path: u.pathname + (u.search || ""),
      method: init.method || "GET",
      body: init.body ? JSON.parse(init.body) : null,
      auth: init.headers?.Authorization || null,
    });
    const key = Object.keys(routes).find((k) => (u.pathname + (u.search || "")) === k
      || u.pathname === k);
    if (!key) return { ok: false, status: 404, text: async () => "no route" };
    const r = routes[key];
    const body = typeof r === "function" ? r(u, init) : r;
    if (body instanceof Error) throw body;
    if (body && body.__status) {
      return { ok: false, status: body.__status, statusText: "", text: async () => body.__text || "" };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return calls;
}

// ---------------------------------------------------------------------------
// Diff engine
// ---------------------------------------------------------------------------

test("flatten produces dotted paths with list indices", () => {
  assert.deepEqual(flatten({ a: { b: 1 }, c: [10, 20] }), {
    "a.b": "1", "c[0]": "10", "c[1]": "20",
  });
  assert.deepEqual(flatten({ nil: null }), { nil: "" });
  assert.deepEqual(flatten({ deep: [{ x: true }] }), { "deep[0].x": "true" });
});

test("computeChanges classifies Added, Removed and Changed", () => {
  const rows = computeChanges(
    { peers: { "10.0.0.1": "Established" }, gone: "yes" },
    { peers: { "10.0.0.1": "Idle" }, fresh: "new" },
    "bgp_summary",
  );
  const by = Object.fromEntries(rows.map((r) => [r.path, r]));
  assert.equal(by["peers.10.0.0.1"].change, "Changed");
  assert.equal(by["peers.10.0.0.1"].pre, "Established");
  assert.equal(by["peers.10.0.0.1"].post, "Idle");
  assert.equal(by.gone.change, "Removed");
  assert.equal(by.gone.post, "");
  assert.equal(by.fresh.change, "Added");
  assert.equal(by.fresh.pre, "");
  assert.ok(rows.every((r) => r.command === "bgp_summary"));
});

test("computeChanges reports nothing when the captures match", () => {
  const same = { a: 1, b: [2, 3] };
  assert.deepEqual(computeChanges(same, { a: 1, b: [2, 3] }, "k"), []);
});

test("a value that becomes an empty string is Changed, not Removed", () => {
  // The distinction matters: Removed means the path is gone from the payload.
  const rows = computeChanges({ x: "v" }, { x: "" }, "k");
  assert.equal(rows[0].change, "Changed");
});

test("SequenceMatcher opcodes match Python difflib with autojunk=False", () => {
  // Fixture generated from difflib.SequenceMatcher(None, a, b, autojunk=False).
  const cases = [
    ["abc", "abd", [["equal", 0, 2, 0, 2], ["replace", 2, 3, 2, 3]]],
    ["", "new", [["insert", 0, 0, 0, 3]]],
    ["old", "", [["delete", 0, 3, 0, 0]]],
    ["abc", "abc", [["equal", 0, 3, 0, 3]]],
    ["Established", "Idle", [["replace", 0, 5, 0, 2], ["equal", 5, 6, 2, 3],
      ["delete", 6, 9, 3, 3], ["equal", 9, 10, 3, 4], ["delete", 10, 11, 4, 4]]],
  ];
  for (const [a, b, expected] of cases) {
    assert.deepEqual(new SequenceMatcher([...a], [...b]).getOpcodes(), expected, `${a} -> ${b}`);
  }
});

test("charDiff highlights only what moved", () => {
  const [pre, post] = charDiff("10.0.0.1", "10.0.0.2");
  assert.deepEqual(pre, [["10.0.0.", false], ["1", true]]);
  assert.deepEqual(post, [["10.0.0.", false], ["2", true]]);

  const [p2, q2] = charDiff("", "added");
  assert.deepEqual(p2, []);
  assert.deepEqual(q2, [["added", true]]);

  // Reassembling the segments must give the original back.
  const join = (segs) => segs.map(([t]) => t).join("");
  const a = "ge-0/0/1 up full 1000";
  const b = "ge-0/0/1 down half 100";
  const [pa, pb] = charDiff(a, b);
  assert.equal(join(pa), a);
  assert.equal(join(pb), b);
});

// ---------------------------------------------------------------------------
// Conductor layer
// ---------------------------------------------------------------------------

test("normalizeBaseUrl adds https, strips paths and rejects http", () => {
  assert.equal(normalizeBaseUrl("conductor.example.com"), BASE);
  assert.equal(normalizeBaseUrl("https://conductor.example.com/"), BASE);
  assert.equal(normalizeBaseUrl("https://conductor.example.com/api/v1"), BASE);
  assert.equal(normalizeBaseUrl(" conductor.example.com:8443 "), "https://conductor.example.com:8443");
  assert.throws(() => normalizeBaseUrl("http://conductor.example.com"), /HTTPS/);
  assert.throws(() => normalizeBaseUrl(""), /Enter the Conductor URL/);
  assert.throws(() => normalizeBaseUrl("https://"), /Enter the Conductor URL/);
  assert.throws(() => normalizeBaseUrl("https:///"), /Enter the Conductor URL/);
  assert.throws(() => normalizeBaseUrl("not a host"), /not a valid/);
});

test("authenticate POSTs credentials and accepts either token field", async () => {
  let calls = stubConductor({ "/api/v1/login": { token: "tok-1" } });
  assert.equal(await authenticate(BASE, "ada", "pw"), "tok-1");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, { username: "ada", password: "pw" });
  assert.equal(calls[0].auth, null, "no bearer token exists yet");

  stubConductor({ "/api/v1/login": { sessionToken: "tok-2" } });
  assert.equal(await authenticate(BASE, "ada", "pw"), "tok-2", "sessionToken is accepted too");

  calls = stubConductor({ "/api/v1/login": { somethingElse: true } });
  await assert.rejects(() => authenticate(BASE, "ada", "pw"), /returned no token/);
});

test("a rejected login surfaces the status, not a generic failure", async () => {
  stubConductor({ "/api/v1/login": { __status: 401 } });
  await assert.rejects(() => authenticate(BASE, "ada", "bad"), /rejected the request \(401\)/);
});

test("an unreachable Conductor is reported as possibly a certificate problem", async () => {
  stubConductor({ "/api/v1/login": new TypeError("Failed to fetch") });
  await assert.rejects(
    () => authenticate(BASE, "ada", "pw"),
    (e) => e.tls === true && /certificate is not trusted/.test(e.message),
  );
});

test("routerNodesFromAssets groups nodes under their router", () => {
  const map = routerNodesFromAssets([
    { routerName: "r1", nodeName: "n1" },
    { routerName: "r1", nodeName: "n2" },
    { routerName: "r1", nodeName: "n1" },
    { routerName: "r2", nodeName: "n1" },
    { routerName: "r3" },
    { nodeName: "orphan" },
    null,
  ]);
  assert.deepEqual([...map.keys()], ["r1", "r2", "r3"]);
  assert.deepEqual(map.get("r1"), ["n1", "n2"], "duplicates collapse");
  assert.deepEqual(map.get("r3"), [], "a router with no node is still a router");
  assert.equal(map.has("orphan"), false);
});

test("the nine checks keep their endpoints and types", () => {
  assert.equal(Object.keys(CHECKS).length, 9);
  assert.deepEqual(CHECKS.bgp_summary,
    ["BGP Summary", "router_get", "/api/v1/router/{r}/bgp?command=summary"]);
  assert.equal(CHECKS.aggregate_sessions[1], "router_post",
    "the session-count endpoint only answers to POST");
  const types = new Set(Object.values(CHECKS).map(([, t]) => t));
  assert.deepEqual([...types].sort(), ["node_get", "router_get", "router_post"]);
});

test("collectCheck sends a GET for router checks, with the bearer token", async () => {
  const calls = stubConductor({ "/api/v1/router/r1/bgp?command=summary": { peers: [] } });
  await collectCheck(BASE, "tok", "r1", [], "bgp_summary");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].auth, "Bearer tok");
});

test("collectCheck POSTs the session-count check with no body", async () => {
  const calls = stubConductor({
    "/api/v1/router/r1/stats/aggregate-session/node/session-count": { total: 42 },
  });
  const out = await collectCheck(BASE, "tok", "r1", [], "aggregate_sessions");
  assert.deepEqual(out, { total: 42 });
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].body, null, "a read-via-POST carries no payload");
});

test("collectCheck fans a node check out per node, keyed by node name", async () => {
  const calls = stubConductor({
    "/api/v1/router/r1/node/n1/networkInterface": [{ name: "ge-0" }],
    "/api/v1/router/r1/node/n2/networkInterface": [{ name: "ge-1" }],
  });
  const out = await collectCheck(BASE, "tok", "r1", ["n1", "n2"], "network_interfaces");
  assert.deepEqual(Object.keys(out), ["n1", "n2"]);
  assert.deepEqual(out.n1, [{ name: "ge-0" }]);
  assert.equal(calls.length, 2);
});

test("a router name with awkward characters is encoded into the path", async () => {
  const calls = stubConductor({ "/api/v1/router/r%2Fodd/alarm": [] });
  await collectCheck(BASE, "tok", "r/odd", [], "active_alarms");
  assert.ok(calls[0].path.includes("r%2Fodd"), "the name is URL-encoded, not path-injected");
});

test("the tool declares itself as standalone, not a Mist tool", () => {
  assert.equal(tool.needs.mistToken, false);
  assert.equal(typeof tool.mount, "function", "it renders its own view");
  assert.ok(tool.description.length > 30);
});

// ---------------------------------------------------------------------------
// A full pre -> post cycle over the pure functions
// ---------------------------------------------------------------------------

test("a pre/post cycle finds the BGP peer that dropped", async () => {
  const pre = { peers: { "10.0.0.1": { state: "Established", uptime: "01:00:00" } } };
  const post = { peers: { "10.0.0.1": { state: "Idle", uptime: "00:00:05" } } };

  stubConductor({ "/api/v1/router/r1/bgp?command=summary": pre });
  const captured = await collectCheck(BASE, "tok", "r1", [], "bgp_summary");

  stubConductor({ "/api/v1/router/r1/bgp?command=summary": post });
  const after = await collectCheck(BASE, "tok", "r1", [], "bgp_summary");

  const changes = computeChanges(captured, after, "bgp_summary");
  assert.equal(changes.length, 2);
  const state = changes.find((c) => c.path.endsWith("state"));
  assert.equal(state.pre, "Established");
  assert.equal(state.post, "Idle");
  assert.equal(state.change, "Changed");

  const [p, q] = charDiff(state.pre, state.post);
  assert.ok(p.some(([, hot]) => hot), "the changed text is highlighted");
  assert.ok(q.some(([, hot]) => hot));
});
