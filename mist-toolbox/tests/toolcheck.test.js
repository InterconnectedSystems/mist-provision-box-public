// The upload check: the wrong kind of file is explained, the right kind passes.

import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  UNDECLARED_WRITE_WARNING, WRITE_WARNING, checkToolSource, detectWrites, toolFilename,
} from "../lib/toolcheck.js";
import { BUILTIN_TOOLS, validateTool } from "../tools/registry.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The shape of the file that started this: mist_switch_report.js.
const NODE_SCRIPT = `#!/usr/bin/env node
"use strict";
const readline = require("readline");
const ExcelJS = require("exceljs");
async function main() {
  const resp = await fetch("https://api.gc2.mist.com/api/v1/self");
  console.log("done");
  process.exit(0);
}
main();
`;

test("a Node CLI script is rejected as a Node script, before anything else", () => {
  const { problems } = checkToolSource(NODE_SCRIPT, "mist switch report.js");
  assert.match(problems[0], /This is a Node\.js script \(uses require\(\), process, a #!node line\)/);
  assert.match(problems[0], /Copy AI prompt/);
  assert.ok(problems.some((p) => /export default/.test(p)));
  assert.ok(problems.some((p) => /fetch\(\) directly/.test(p)));
  assert.ok(problems.some((p) => /console/.test(p)));
});

test("a Python script is named as one", () => {
  const py = "import requests\nfrom openpyxl import Workbook\n\ndef main():\n    pass\n";
  assert.match(checkToolSource(py, "x.js").problems[0], /Python script/);
  assert.match(checkToolSource("anything", "report.py").problems[0], /Python script/);
});

test("policy breaches are each reported", () => {
  const base = 'export default { id: "a", name: "A", description: "d", run() {} };\n';
  const cases = [
    ["localStorage.setItem('k', 1);", /browser storage/],
    ["chrome.runtime.sendMessage({});", /service worker/],
    ["fetch(u, { method: 'POST' });", /fetch\(\) directly/],
    ["new XMLHttpRequest();", /network connection/],
    ["eval('1');", /eval/],
    ["await import('./x.js');", /dynamic import/],
    ['import x from "https://cdn.example/x.js";', /imports "https:\/\/cdn\.example\/x\.js"/],
    ['import x from "exceljs";', /imports "exceljs"/],
  ];
  for (const [line, re] of cases) {
    const { problems } = checkToolSource(base + line);
    assert.ok(problems.some((p) => re.test(p)), `${line} → ${problems.join(" | ")}`);
  }
});

test("a tool that makes changes is warned about, labelled, and still installable", () => {
  const base = 'export default { id: "a", name: "A", description: "d", writes: true, async run(ctx) {\n';
  for (const call of [
    'await ctx.mistWrite("PUT", "/sites/x", { notes: "n" });',
    'await ctx.mistWrite("DELETE", "/sites/x/wlans/y");',
    'await something({ method: "PATCH" });',
  ]) {
    const r = checkToolSource(`${base}${call}\n} };`);
    assert.deepEqual(r.problems, [], call);
    assert.equal(r.writes, true, call);
    assert.equal(r.writeWarnings[0], WRITE_WARNING, call);
    assert.equal(r.writeWarnings.length, 1, "declared, so no second warning");
  }
  const undeclared = checkToolSource('export default { id: "a", name: "A", description: "d", '
    + 'async run(ctx) { await ctx.mistWrite("POST", "/x", {}); } };');
  assert.deepEqual(undeclared.problems, []);
  assert.deepEqual(undeclared.writeWarnings, [WRITE_WARNING, UNDECLARED_WRITE_WARNING]);
});

test("a read-only tool gets no write warning", () => {
  const r = checkToolSource('export default { id: "a", name: "A", description: "d", '
    + 'async run(ctx) { return ctx.getAll("/x"); } };');
  assert.equal(r.writes, false);
  assert.deepEqual(r.writeWarnings, []);
  assert.equal(detectWrites("ctx.mistGet('/x')"), false);
  assert.equal(detectWrites("ctx.mistWrite('POST', '/x', {})"), true);
});

test("ctx.token is called out: tools are not given the token", () => {
  const r = checkToolSource('export default { id: "a", name: "A", description: "d", run(ctx) { return ctx.token; } };');
  assert.ok(r.warnings.some((w) => /not given/.test(w)), r.warnings.join(" | "));
});

test("the toolbox's own modules may be imported", () => {
  const src = 'import { overlaps } from "../lib/subnet.js";\nimport { pool } from "../mist.js";\n'
    + 'export default { id: "a", name: "A", description: "d", run() {} };';
  assert.deepEqual(checkToolSource(src).problems, []);
});

test("a bad id is caught early", () => {
  const src = 'export default { id: "My Tool", name: "A", description: "d", run() {} };';
  assert.ok(checkToolSource(src).problems.some((p) => /lowercase/.test(p)));
});

test("every shipped tool passes the upload check", async () => {
  // The SSR check itself (ssr/ssr-pre-post.js) has its own fetch and POST
  // /login; what sits in tools/ is only its launcher, which passes like the rest.
  for (const file of BUILTIN_TOOLS) {
    const text = await readFile(join(root, "tools", file), "utf8");
    const r = checkToolSource(text, file);
    assert.deepEqual(r.problems, [], file);
    // Read-only unless labelled: the built-ins that make changes declare it,
    // so they get the main warning and not the "undeclared" one.
    const writes = ["ap-site-upgrade.js", "ssid-client-lists.js", "switch-site-upgrade.js"].includes(file);
    assert.equal(r.writes, writes, file);
    assert.equal(r.writeWarnings.length, writes ? 1 : 0, file);
  }
});

test("the template passes the check, loads, and is a valid tool", async () => {
  const path = join(root, "docs", "tool-template.js");
  const { problems, id, name } = checkToolSource(await readFile(path, "utf8"), "tool-template.js");
  assert.deepEqual(problems, []);
  const tool = validateTool((await import(pathToFileURL(path).href)).default, "tool-template.js");
  assert.equal(tool.id, id);
  assert.equal(tool.name, name);
});

test("toolFilename turns an upload name into a tools/ filename", () => {
  assert.equal(toolFilename("mist switch report.js"), "mist-switch-report.js");
  assert.equal(toolFilename("My_Report.JS"), "my_report.js");
  assert.equal(toolFilename("..evil/../x.js"), "evil-x.js");
  assert.equal(toolFilename("report v1.2.js"), "report-v1-2.js");
  assert.equal(toolFilename("!!!.js"), "");
});
