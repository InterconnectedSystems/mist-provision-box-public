// A tool that fails to load must fail loudly, by name, at test time — not
// silently in the menu.

import { strict as assert } from "node:assert";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateTool } from "../tools/registry.js";

const toolsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "tools");

const ok = { id: "a-tool", name: "A Tool", description: "Does a thing.", run() {} };

test("validateTool accepts a well-formed tool", () => {
  assert.equal(validateTool({ ...ok }, "a.js").id, "a-tool");
});

test("validateTool names the missing field", () => {
  assert.throws(() => validateTool({ ...ok, description: "" }, "a.js"), /"description" must be a non-empty string/);
  assert.throws(() => validateTool({ ...ok, name: undefined }, "a.js"), /"name" must be a non-empty string/);
  assert.throws(() => validateTool({ ...ok, run: "nope" }, "a.js"), /"run" must be a function/);
  assert.throws(() => validateTool(null, "a.js"), /no default export object/);
  assert.throws(() => validateTool({ ...ok, id: "Not An Id" }, "a.js"), /lowercase letters/);
});

test("validateTool accepts writes as a boolean only", () => {
  assert.equal(validateTool({ ...ok, writes: true }, "a.js").writes, true);
  assert.equal(validateTool({ ...ok, writes: false }, "a.js").writes, false);
  assert.throws(() => validateTool({ ...ok, writes: "yes" }, "a.js"), /"writes" must be true or false/);
});

test("validateTool rejects an unknown param type", () => {
  assert.throws(
    () => validateTool({ ...ok, params: [{ id: "x", type: "colorwheel" }] }, "a.js"),
    /unknown type "colorwheel"/,
  );
  assert.throws(() => validateTool({ ...ok, params: [{ label: "no id" }] }, "a.js"), /every param needs an "id"/);
});

test("every tool listed in tools.json exists, loads and is valid", async () => {
  const list = JSON.parse(await readFile(join(toolsDir, "tools.json"), "utf8"));
  assert.ok(Array.isArray(list) && list.length, "tools.json must list at least one tool");
  const seen = new Set();
  for (const file of list) {
    const mod = await import(pathToFileURL(join(toolsDir, file)).href);
    const tool = validateTool(mod.default, file);
    assert.ok(!seen.has(tool.id), `duplicate tool id ${tool.id}`);
    seen.add(tool.id);
    assert.ok(tool.description.length > 30, `${file}: description should actually describe the tool`);
  }
});

test("no tool file is left out of tools.json by accident", async () => {
  const list = new Set(JSON.parse(await readFile(join(toolsDir, "tools.json"), "utf8")));
  const onDisk = (await readdir(toolsDir)).filter((f) => f.endsWith(".js") && f !== "registry.js");
  const missing = onDisk.filter((f) => !list.has(f));
  assert.deepEqual(missing, [], `run \`npm run scan\` — these are not registered: ${missing.join(", ")}`);
});
