// Port Stats Correlator: its counter model, both data sources, the baseline
// deltas and the MTU summary. The view itself is DOM (mount), so the pure
// parts are exported and tested here, against the same synthetic
// `show interfaces extensive` fixture the shell tests use.

import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { interfaceCounters } from "../lib/junos-shell.js";
import { checkToolSource } from "../lib/toolcheck.js";
import { validateTool } from "../tools/registry.js";
import tool, {
  ALL_COUNTERS, INPUT_ERRORS, MAC_ERRORS, OUTPUT_ERRORS, buildRows, cliSample, diff, fmtRate, isRefusal,
  latestPerPort, rawRecord, restSample, smallestMtu,
} from "../tools/port-stats-correlator.js";
import { testCtx } from "./helpers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const iface = async () => interfaceCounters(JSON.parse(await readFile(join(here, "fixtures", "junos-show-interfaces-extensive.json"), "utf8")))[0];

test("the tool loads, passes the install check and is read-only", async () => {
  const src = await readFile(join(here, "..", "tools", "port-stats-correlator.js"), "utf8");
  const check = checkToolSource(src, "port-stats-correlator.js");
  assert.deepEqual(check.problems, []);
  assert.equal(check.writes, false);
  validateTool(tool, "port-stats-correlator.js");
  assert.equal(typeof tool.mount, "function");
  assert.match(src, /ctx\.junosShow\(/, "reads the switch CLI through ctx.junosShow");
});

test("the counters follow show interfaces extensive, and every key is one the CLI returns", async () => {
  const keys = new Set(Object.keys((await iface()).counters));
  for (const k of ALL_COUNTERS) assert.ok(keys.has(k.key), `${k.key} is not in the CLI reply`);
  const labels = (list) => list.map((k) => k.label);
  assert.deepEqual(labels(INPUT_ERRORS).slice(0, 4), ["Errors", "Drops", "Framing errors", "Runts"]);
  assert.ok(labels(OUTPUT_ERRORS).includes("MTU errors"));
  assert.ok(labels(MAC_ERRORS).includes("CRC/Align errors in"));
  assert.ok(labels(MAC_ERRORS).includes("Queue drops (all queues)"));
});

test("cliSample reads link, speed, MTU, rates and counters from the CLI record", async () => {
  const s = cliSample(await iface());
  assert.equal(s.src, "cli");
  assert.equal(s.up, true);
  assert.equal(s.speed, "2500M");
  assert.equal(s.duplex, "full duplex");
  assert.equal(s.mtu, 1514);
  assert.equal(typeof s.txBps, "number");
  assert.equal(s.counters["mac.input-crc-errors"], 9);
  assert.equal(s.counters["out.mtu-errors"], 5);
  const raw = rawRecord(s);
  assert.equal(raw.name, "ge-0/0/1");
  assert.equal(raw["queue 1 network-control drops"] ?? Object.entries(raw).find(([k]) => /^queue 1 /.test(k))[1], "7");
});

test("restSample maps the few counters Mist's port stats have", () => {
  const s = restSample({ port_id: "ge-0/0/1", up: true, speed: 1000, full_duplex: true, rx_errors: 4, tx_errors: 1,
    rx_bytes: 100, tx_bytes: 200, rx_pkts: 3, tx_pkts: 5, rx_bps: 800, tx_bps: 1600, timestamp: 1760000000 });
  assert.equal(s.src, "rest");
  assert.equal(s.speed, "1G");
  assert.equal(s.mtu, null);
  assert.deepEqual(s.counters, {
    "in.input-errors": 4, "out.output-errors": 1, "traffic.input-bytes": 100, "traffic.output-bytes": 200,
    "traffic.input-packets": 3, "traffic.output-packets": 5,
  });
  assert.equal(rawRecord(s).rx_errors, "4");
});

test("diff reports growth, and a counter that went backwards as reset", () => {
  assert.equal(diff(10, 4), 6);
  assert.equal(diff(4, 4), 0);
  assert.equal(diff(1, 4), "reset");
  assert.equal(diff(null, 4), null);
});

test("buildRows works out deltas per hop and marks the hop that picked up errors", async () => {
  const one = await iface();
  const flow = [
    { key: "a", siteName: "Demo HQ", switchName: "demo-sw1", portId: "ge-0/0/1" },
    { key: "b", siteName: "Demo HQ", switchName: "demo-sw2", portId: "ge-0/0/2" },
    { key: "c", siteName: "Demo HQ", switchName: "demo-sw3", portId: "ge-0/0/3" },
  ];
  const sample = (t, patch, up = "up") => ({ t, s: cliSample({ ...one, operStatus: up, counters: { ...one.counters, ...patch } }) });
  const base = new Map([["a", sample(1, {})], ["b", sample(1, {})], ["c", sample(1, {})]]);
  const cur = new Map([
    ["a", sample(2, { "traffic.input-bytes": one.counters["traffic.input-bytes"] + 500 })],
    ["b", sample(2, { "mac.input-crc-errors": 9 + 40, "in.input-errors": 12 + 40 })],
    ["c", sample(2, {}, "down")],
  ]);
  const rows = buildRows(flow, cur, base);
  assert.deepEqual(rows.map((r) => r.state), ["ok", "errors", "down"]);
  assert.equal(rows[0].vals["traffic.input-bytes"].d, 500, "traffic moves, but is not an error");
  assert.equal(rows[0].newErrors, 0);
  assert.equal(rows[1].vals["mac.input-crc-errors"].d, 40);
  assert.equal(rows[1].newErrors, 80);
  assert.equal(rows[1].since, 1);

  // No data yet for a hop.
  assert.equal(buildRows([flow[0]], new Map(), new Map())[0].state, "nodata");
  // A baseline from the other source is not compared against.
  const rest = { t: 1, s: restSample({ up: true, rx_errors: 0 }) };
  const mixed = buildRows([flow[0]], new Map([["a", sample(2, {})]]), new Map([["a", rest]]));
  assert.equal(mixed[0].since, null);
  assert.equal(mixed[0].vals["in.input-errors"].d, null);
});

test("smallestMtu names the hops with the smallest MTU", async () => {
  const one = await iface();
  const r = (hop, mtu) => ({ hop, s: cliSample({ ...one, mtu }) });
  assert.deepEqual(smallestMtu([r(1, 9200), r(2, 1514), r(3, 9200)]), { mtu: 1514, hops: [2], uniform: false });
  assert.deepEqual(smallestMtu([r(1, 9200), r(2, 9200)]), { mtu: 9200, hops: [1, 2], uniform: true });
  assert.equal(smallestMtu([{ hop: 1, s: restSample({ up: true }) }]), null, "Mist stats have no MTU");
});

test("isRefusal tells a refused CLI session from a passing failure", () => {
  assert.ok(isRefusal("Your token may not open a CLI session on this switch (403). Remote shell needs an admin-level role in Mist."));
  assert.ok(!isRefusal("The switch did not answer within 30 s (show interfaces extensive ge-0/0/1)."));
});

test("latestPerPort keeps the newest record per port, for this switch only", () => {
  const out = latestPerPort([
    { port_id: "ge-0/0/10", mac: "aa", timestamp: 1 },
    { port_id: "ge-0/0/2", mac: "aa", timestamp: 1 },
    { port_id: "ge-0/0/2", mac: "aa", timestamp: 5, tag: "new" },
    { port_id: "ge-0/0/3", mac: "bb", timestamp: 9 },
  ], "aa");
  assert.deepEqual(out.map((p) => p.port_id), ["ge-0/0/2", "ge-0/0/10"]);
  assert.equal(out[0].tag, "new");
});

test("fmtRate scales bits per second", () => {
  assert.equal(fmtRate(312), "312 bps");
  assert.equal(fmtRate(2_500_000), "2.5 Mbps");
  assert.equal(fmtRate(null), "");
});

test("run() points the user to the view, and the CLI path goes through the read-only gate", async () => {
  const ctx = testCtx({ shell: async () => ({ "interface-information": [] }) });
  const res = await tool.run(ctx);
  assert.match(res.summary, /picker/);
  await ctx.junosShow("site-1", "020000000001", "show interfaces extensive ge-0/0/1");
  assert.deepEqual(ctx.shellCalls[0].command, "show interfaces extensive ge-0/0/1");
  await assert.rejects(ctx.junosShow("site-1", "020000000001", "clear interfaces statistics ge-0/0/1"), /show/);
});
