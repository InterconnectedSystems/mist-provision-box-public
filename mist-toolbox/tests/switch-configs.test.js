// Switch Config Export: one switch is a .txt, several are one .zip with a
// folder per site and an index.csv. The zip is read back by Python's zipfile,
// an independent reader.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import tool from "../tools/switch-configs.js";
import { stubMist, testCtx } from "./helpers.mjs";

const SITES = [{ id: "s1", name: "HQ" }, { id: "s2", name: "Branch Office" }];
const INVENTORY = [
  { mac: "AABBCC000001", id: "dev-1", name: "hq-sw1", model: "EX4400", serial: "S1", site_id: "s1" },
  { mac: "AABBCC000002", vc_mac: "AABBCC000002", id: "dev-2", name: "br-sw1", model: "EX4100", serial: "S2", site_id: "s2" },
  { mac: "AABBCC000003", vc_mac: "AABBCC000002", id: "dev-3", name: "br-member", model: "EX4100", serial: "S3", site_id: "s2" },
  { mac: "AABBCC000009", id: "dev-9", name: "spare", model: "EX2300", serial: "S9" },
];
const routes = (o = {}) => ({
  "/orgs/org-1/sites": SITES,
  "/orgs/org-1/inventory": INVENTORY,
  "/sites/s1/devices/dev-1/config_cmd": { cli: ["set system host-name hq-sw1", "set vlans data vlan-id 10"] },
  "/sites/s2/devices/dev-2/config_cmd": { cli: "set system host-name br-sw1\nset vlans voice vlan-id 20" },
  ...o,
});

function ctxWithDownloads(params) {
  const ctx = testCtx({ params });
  ctx.saved = [];
  ctx.download = (blob, name) => ctx.saved.push({ blob, name });
  return ctx;
}

async function zipListing(blob) {
  const dir = await mkdtemp(join(tmpdir(), "swcfg-"));
  const path = join(dir, "out.zip");
  await writeFile(path, Buffer.from(await blob.arrayBuffer()));
  const out = execFileSync("python3", ["-I", "-c", `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
print(json.dumps({n: z.read(n).decode() for n in z.namelist()}))
`, path]);
  return JSON.parse(out.toString());
}

test("one switch downloads as a single .txt", async () => {
  stubMist(routes());
  const ctx = ctxWithDownloads({ allSites: false, siteId: "s1" });
  const result = await tool.run(ctx);
  assert.equal(ctx.saved.length, 1, "downloaded automatically, once");
  assert.equal(ctx.saved[0].name, "HQ__hq-sw1__aabbcc000001.txt");
  assert.equal(await ctx.saved[0].blob.text(), "set system host-name hq-sw1\nset vlans data vlan-id 10\n");
  assert.equal(result.files.length, 1);
  assert.equal(result.sheets, undefined, "configs, not a spreadsheet");
});

test("several switches download as one .zip with site folders and an index", async () => {
  stubMist(routes());
  const ctx = ctxWithDownloads({ allSites: true });
  const result = await tool.run(ctx);
  assert.equal(ctx.saved.length, 1);
  assert.match(ctx.saved[0].name, /^mist_switch_configs_Acme_Corp_\d{8}_\d{6}\.zip$/);
  const files = await zipListing(ctx.saved[0].blob);
  assert.deepEqual(Object.keys(files).sort(), [
    "Branch_Office/Branch_Office__br-sw1__aabbcc000002.txt",
    "HQ/HQ__hq-sw1__aabbcc000001.txt",
    "index.csv",
  ]);
  assert.equal(files["Branch_Office/Branch_Office__br-sw1__aabbcc000002.txt"],
    "set system host-name br-sw1\nset vlans voice vlan-id 20\n", "string cli is split into lines");
  assert.match(files["index.csv"], /^Site,Switch,MAC,Model,Serials,VC Members,Config Lines,Status,Error,File\r\n/);
  assert.match(files["index.csv"], /Branch Office,br-sw1,aabbcc000002,EX4100,"S2, S3",2,2,Exported/,
    "the VC is one switch with both serials");
  // Per-switch buttons as well as the zip.
  assert.deepEqual(result.files.map((f) => f.name).slice(1).sort(),
    ["Branch_Office__br-sw1__aabbcc000002.txt", "HQ__hq-sw1__aabbcc000001.txt"]);
  assert.ok(!result.preview.rows.some((r) => r.name === "spare"), "unassigned switches have no config to fetch");
});

test("a failing switch is recorded; the rest still export", async () => {
  stubMist(routes({ "/sites/s1/devices/dev-1/config_cmd": () => { throw new Error("boom"); } }));
  const ctx = ctxWithDownloads({ allSites: true });
  const result = await tool.run(ctx);
  assert.equal(ctx.saved[0].name, "Branch_Office__br-sw1__aabbcc000002.txt", "one left, so a plain .txt");
  assert.match(result.summary, /1 of 2 switch config\(s\) exported.*1 failed/);
  assert.equal(result.preview.rows.find((r) => r.name === "hq-sw1").status, "Error");
});

test("one site only asks for that site's configs", async () => {
  const calls = stubMist(routes());
  await tool.run(ctxWithDownloads({ allSites: false, siteId: "s2" }));
  assert.ok(!calls.some((c) => c.startsWith("/sites/s1/")));
});
