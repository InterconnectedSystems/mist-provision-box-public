// mistWrite: the one way a labelled tool changes Mist. Same fetch, same host
// allowlist as every GET; never retried; plain messages on refusal.

import { strict as assert } from "node:assert";
import test from "node:test";

import { mistWrite } from "../mist.js";
import { HOST } from "./helpers.mjs";

const TOKEN = "t".repeat(20);

function stub(status, body = "") {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return { ok: status >= 200 && status < 300, status, statusText: "", headers: { get: () => null },
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };
  return seen;
}

test("sends the method, a JSON body and the content type, and returns the reply", async () => {
  const seen = stub(200, { id: "s1", notes: "hi" });
  const out = await mistWrite(HOST, TOKEN, "put", "/sites/s1", { notes: "hi" });
  assert.deepEqual(out, { id: "s1", notes: "hi" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `https://${HOST}/api/v1/sites/s1`);
  assert.equal(seen[0].init.method, "PUT");
  assert.equal(seen[0].init.body, JSON.stringify({ notes: "hi" }));
  assert.equal(seen[0].init.headers["Content-Type"], "application/json");
  assert.equal(seen[0].init.credentials, "omit");
});

test("a DELETE without a body sends none", async () => {
  const seen = stub(204);
  assert.equal(await mistWrite(HOST, TOKEN, "DELETE", "/sites/s1/wlans/w1"), null);
  assert.equal(seen[0].init.body, undefined);
  assert.equal(seen[0].init.headers["Content-Type"], undefined);
});

test("refuses GET and anything that is not a write method", async () => {
  stub(200, {});
  for (const m of ["GET", "HEAD", "", "OPTIONS"]) {
    await assert.rejects(mistWrite(HOST, TOKEN, m, "/sites/s1", {}), /POST, PUT, PATCH or DELETE/, m);
  }
});

test("a 429 is not retried, so a change is never applied twice", async () => {
  const seen = stub(429);
  await assert.rejects(mistWrite(HOST, TOKEN, "POST", "/orgs/o/sites", { name: "x" }), /not retried/);
  assert.equal(seen.length, 1);
});

test("a 403 says the token may not make this change", async () => {
  stub(403);
  await assert.rejects(mistWrite(HOST, TOKEN, "PUT", "/sites/s1", {}), /not allowed to make this change/);
});

test("a 404 is an error for a write, not an empty result", async () => {
  stub(404, "not found");
  await assert.rejects(mistWrite(HOST, TOKEN, "PUT", "/sites/nope", {}), /Mist API 404/);
});

test("the host allowlist applies to writes too", async () => {
  const seen = stub(200, {});
  await assert.rejects(mistWrite("evil.example.com", TOKEN, "POST", "/x", {}), /not a known Mist API region/);
  assert.equal(seen.length, 0);
});
