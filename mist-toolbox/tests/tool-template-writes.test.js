// The template for tools that make changes teaches a pattern; prove it holds:
// a dry run sends nothing, a read-only token stops before sending, and a token
// that can write sends exactly the planned changes, once each.

import { strict as assert } from "node:assert";
import test from "node:test";

import tool from "../docs/tool-template-writes.js";
import { sheetNamed, stubMist, testCtx } from "./helpers.mjs";

const SITES = [{ id: "s1", name: "HQ", notes: "old" }, { id: "s2", name: "Branch", notes: "same" }];
const routes = { "/orgs/org-1/sites": SITES, "/sites/s1": { id: "s1" }, "/sites/s2": { id: "s2" } };
const params = (o) => ({ allSites: true, notes: "same", mode: "replace", dryRun: true, ...o });

test("a dry run plans every change and sends nothing", async () => {
  stubMist(routes);
  const ctx = testCtx({ params: params({}), role: "write" });
  const result = await tool.run(ctx);
  assert.deepEqual(ctx.writes, []);
  assert.deepEqual(sheetNamed(result, "Planned Changes").rows.map((r) => [r.site, r.action]),
    [["Branch", "No change"], ["HQ", "Update"]]);
  assert.match(result.summary, /^Dry run: 1 of 2 site\(s\) would be updated$/);
});

test("a read-only token stops before anything is sent", async () => {
  stubMist(routes);
  const ctx = testCtx({ params: params({ dryRun: false }), role: "read" });
  await assert.rejects(tool.run(ctx), /cannot make changes.*Nothing was sent/);
  assert.deepEqual(ctx.writes, []);
});

test("with a token that can write, only the planned changes are sent", async () => {
  stubMist(routes);
  const ctx = testCtx({ params: params({ dryRun: false, mode: "append", notes: "new" }), role: "write" });
  const result = await tool.run(ctx);
  assert.deepEqual(ctx.writes, [
    { method: "PUT", path: "/sites/s2", body: { notes: "same\nnew" } },
    { method: "PUT", path: "/sites/s1", body: { notes: "old\nnew" } },
  ]);
  assert.deepEqual(sheetNamed(result, "Changes").rows.map((r) => r.action), ["Updated", "Updated"]);
});
