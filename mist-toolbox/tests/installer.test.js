// Installing into the extension folder, against an in-memory stand-in for the
// File System Access API's directory handle.

import { strict as assert } from "node:assert";
import test from "node:test";

import {
  formatToolsJson, installTool, removeTool, toolExists, verifyExtensionDir,
} from "../lib/installer.js";

class NotFound extends Error { constructor(n) { super(`${n} not found`); this.name = "NotFoundError"; } }

class FakeDir {
  constructor(name, entries = {}) {
    this.name = name;
    this.entries = new Map();
    for (const [k, v] of Object.entries(entries)) {
      this.entries.set(k, typeof v === "string" ? { text: v } : new FakeDir(k, v));
    }
  }
  async getDirectoryHandle(n) {
    const e = this.entries.get(n);
    if (!(e instanceof FakeDir)) throw new NotFound(n);
    return e;
  }
  async getFileHandle(n, { create } = {}) {
    let e = this.entries.get(n);
    if (!e && create) { e = { text: "" }; this.entries.set(n, e); }
    if (!e || e instanceof FakeDir) throw new NotFound(n);
    return {
      getFile: async () => ({ text: async () => e.text }),
      createWritable: async () => {
        let buf = "";
        return { write: async (t) => { buf = t; }, close: async () => { e.text = buf; } };
      },
    };
  }
  async removeEntry(n) {
    if (!this.entries.delete(n)) throw new NotFound(n);
  }
  file(n) { return this.entries.get(n)?.text; }
}

const RUNNING = { name: "Mist Toolbox", version: "1.0.0" };
const LIST = ["ssid-report.js", "wifi-clients.js"];

function extension(extra = {}) {
  return new FakeDir("mist-toolbox", {
    "manifest.json": JSON.stringify(RUNNING),
    tools: { "tools.json": formatToolsJson(LIST), "ssid-report.js": "builtin", ...extra },
  });
}

test("the right folder is accepted and its tools/ handle returned", async () => {
  const tools = await verifyExtensionDir(extension(), RUNNING);
  assert.equal(tools.name, "tools");
});

test("the wrong folder is refused with a reason", async () => {
  await assert.rejects(verifyExtensionDir(new FakeDir("Downloads"), RUNNING), /has no manifest\.json/);
  await assert.rejects(
    verifyExtensionDir(new FakeDir("other", { "manifest.json": '{"name":"Other","version":"1"}' }), RUNNING),
    /holds the extension "Other"/,
  );
  await assert.rejects(
    verifyExtensionDir(new FakeDir("old", { "manifest.json": '{"name":"Mist Toolbox","version":"0.9.0"}' }), RUNNING),
    /version 0\.9\.0/,
  );
  await assert.rejects(
    verifyExtensionDir(new FakeDir("x", { "manifest.json": JSON.stringify(RUNNING) }), RUNNING),
    /no tools\/ folder/,
  );
});

test("install writes the file and lists it in tools.json, sorted", async () => {
  const tools = await verifyExtensionDir(extension(), RUNNING);
  const verified = [];
  const res = await installTool(tools, "my-report.js", "export default {}", async (f) => { verified.push(f); });
  assert.deepEqual(res, { replaced: false });
  assert.deepEqual(verified, ["my-report.js"]);
  assert.equal(tools.file("my-report.js"), "export default {}");
  assert.equal(tools.file("tools.json"), formatToolsJson(["my-report.js", ...LIST]));
  assert.deepEqual(JSON.parse(tools.file("tools.json")), ["my-report.js", "ssid-report.js", "wifi-clients.js"]);
  assert.ok(await toolExists(tools, "my-report.js"));
});

test("a tool that fails to load is rolled back completely", async () => {
  const tools = await verifyExtensionDir(extension(), RUNNING);
  const before = tools.file("tools.json");
  await assert.rejects(
    installTool(tools, "bad.js", "export default 1", async () => { throw new Error("no default export object"); }),
    /no default export object/,
  );
  assert.equal(tools.file("tools.json"), before);
  assert.equal(await toolExists(tools, "bad.js"), false);
});

test("a failed overwrite restores the previous version", async () => {
  const tools = await verifyExtensionDir(extension({ "mine.js": "v1" }), RUNNING);
  await installTool(tools, "mine.js", "v1", null);
  const before = tools.file("tools.json");
  await assert.rejects(installTool(tools, "mine.js", "v2", async () => { throw new Error("boom"); }));
  assert.equal(tools.file("mine.js"), "v1");
  assert.equal(tools.file("tools.json"), before);
  assert.deepEqual(await installTool(tools, "mine.js", "v3", null), { replaced: true });
  assert.equal(tools.file("mine.js"), "v3");
});

test("built-ins, the registry and odd names are refused", async () => {
  const tools = await verifyExtensionDir(extension(), RUNNING);
  for (const f of ["ssid-report.js", "registry.js", "switch-report.js"]) {
    await assert.rejects(installTool(tools, f, "x", null), /built-in/);
    await assert.rejects(removeTool(tools, f), /built-in/);
  }
  await assert.rejects(installTool(tools, "../manifest.js", "x", null), /not a usable filename/);
  await assert.rejects(installTool(tools, "Upper.js", "x", null), /not a usable filename/);
  assert.equal(tools.file("ssid-report.js"), "builtin");
});

test("remove deletes the file and unlists it", async () => {
  const tools = await verifyExtensionDir(extension(), RUNNING);
  await installTool(tools, "mine.js", "x", null);
  await removeTool(tools, "mine.js");
  assert.equal(await toolExists(tools, "mine.js"), false);
  assert.equal(tools.file("tools.json"), formatToolsJson(LIST));
});

test("tools.json is written exactly as scan-tools.mjs writes it", () => {
  assert.equal(formatToolsJson(["b.js", "a.js", "a.js"]), '[\n  "a.js",\n  "b.js"\n]\n');
});
