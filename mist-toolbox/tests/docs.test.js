// The authoring docs describe the real ctx, the real tool keys and the real
// install rules, and embed the real templates, so they cannot quietly go stale.

import { strict as assert } from "node:assert";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { checkToolSource, detectWrites } from "../lib/toolcheck.js";
import { BUILTIN_TOOLS, validateTool } from "../tools/registry.js";
import { testCtx } from "./helpers.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFile(join(root, p), "utf8");

test("TOOL_GUIDE.md documents every ctx key the shell provides, and no others", async () => {
  const shell = await read("toolbox.js");
  const body = shell.slice(shell.indexOf("function buildCtx"), shell.indexOf("async function run()"));
  const ret = body.slice(body.indexOf("return {"));
  const keys = new Set();
  for (const line of ret.split("\n")) {
    const t = line.replace(/\/\/.*$/, "").trim();
    if (!t || t.startsWith("return") || t.startsWith("}")) continue;
    const m = t.match(/^(\w+):/);
    if (m) keys.add(m[1]);
    else for (const k of t.split(",").map((s) => s.trim()).filter(Boolean)) keys.add(k);
  }
  const guide = await read("docs/TOOL_GUIDE.md");
  const documented = new Set([...guide.matchAll(/^\| `ctx\.(\w+)`/gm)].map((m) => m[1]));
  assert.deepEqual([...documented].sort(), [...keys].sort());
  // The test ctx must offer the same surface, minus the DOM mount point.
  const test = new Set(Object.keys(testCtx()));
  for (const k of keys) if (k !== "mount") assert.ok(test.has(k), `testCtx lacks ${k}`);
});

test("TOOL_PROMPT.md embeds both current templates verbatim", async () => {
  const prompt = await read("docs/TOOL_PROMPT.md");
  for (const file of ["docs/tool-template.js", "docs/tool-template-writes.js"]) {
    const template = (await read(file)).trimEnd();
    assert.ok(prompt.includes(template), `regenerate the example in TOOL_PROMPT.md from ${file}`);
  }
  assert.match(prompt, /PASTE YOUR SCRIPT BELOW/);
});

test("both templates pass the install check and load; only one makes changes", async () => {
  const cases = [["tool-template.js", false], ["tool-template-writes.js", true]];
  for (const [file, writes] of cases) {
    const src = await read(`docs/${file}`);
    const check = checkToolSource(src, file);
    assert.deepEqual(check.problems, [], file);
    assert.equal(detectWrites(src), writes, file);
    assert.equal(check.writeWarnings.length, writes ? 1 : 0, `${file}: declared, so only the main warning`);
    const tool = validateTool((await import(pathToFileURL(join(root, "docs", file)).href)).default, file);
    assert.equal(tool.writes === true, writes, file);
  }
});

test("TOOL_GUIDE.md documents every top-level tool key the shell reads", async () => {
  const guide = await read("docs/TOOL_GUIDE.md");
  const block = guide.slice(guide.indexOf("## 2. The tool object"), guide.indexOf("### `scope:"));
  for (const key of ["id", "name", "description", "tag", "level", "notice", "needs", "scope", "params",
    "writes", "run", "mount"]) {
    assert.match(block, new RegExp(`\\b${key}\\b`), `TOOL_GUIDE.md section 2 does not mention "${key}"`);
  }
});

test("TOOL_PROMPT.md's hard rules cover every rule the install check applies", async () => {
  const prompt = await read("docs/TOOL_PROMPT.md");
  const rules = prompt.slice(prompt.indexOf("## Hard rules"), prompt.indexOf("## Conversion guidance"));
  for (const word of ["require", "process", "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon",
    "localStorage", "indexedDB", "chrome.storage", "console", "eval", "new Function", "import()",
    "sendMessage", "../lib/", "ctx.token", "POST/PUT/PATCH/DELETE", "ctx.mistWrite", "writes: true"]) {
    assert.ok(rules.includes(word), `TOOL_PROMPT.md hard rules do not mention ${word}`);
  }
});

test("BUILTIN_TOOLS is exactly the shipped tools", async () => {
  const onDisk = (await readdir(join(root, "tools")))
    .filter((f) => f.endsWith(".js") && f !== "registry.js").sort();
  assert.deepEqual([...BUILTIN_TOOLS].sort(), onDisk);
});

test("the docs viewer only opens the shipped docs", async () => {
  const viewer = await read("docs/view.js");
  for (const doc of ["TOOL_GUIDE.md", "TOOL_PROMPT.md", "tool-template.js", "tool-template-writes.js"]) {
    assert.ok(viewer.includes(`"${doc}"`));
    await read(`docs/${doc}`);
  }
});
