// Flow Path Analyzer: its counter model, the CLI, Mist-stats and path
// samples, baseline deltas, MTU summary, WAN edge health, next-hop helpers,
// saved flows and the verdict. The view itself is DOM (mount), so the pure
// parts are exported and tested here, against synthetic data and the same
// `show interfaces extensive` fixture the shell tests use.

import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { interfaceCounters, junosJson } from "../lib/junos-shell.js";
import { checkToolSource } from "../lib/toolcheck.js";
import { validateTool } from "../tools/registry.js";
import tool, * as T from "../tools/flow-path-analyzer.js";
import { testCtx } from "./helpers.mjs";

const {
  ALL_COUNTERS, INPUT_ERRORS, MAC_ERRORS, OUTPUT_ERRORS, buildRows, cliSample, diff, fmtRate, isRefusal,
  latestPerPort, rawRecord, restSample, smallestMtu,
} = T;

const here = dirname(fileURLToPath(import.meta.url));
const SITE = { id: "11111111-1111-1111-1111-111111111111", name: "HQ" };
const SITE2 = { id: "22222222-2222-2222-2222-222222222222", name: "Branch" };

test("the tool passes the install check, is read-only and reads the CLI through ctx.junosShow", async () => {
  const src = await readFile(join(here, "..", "tools", "flow-path-analyzer.js"), "utf8");
  const check = checkToolSource(src, "flow-path-analyzer.js");
  assert.deepEqual(check.problems, []);
  assert.deepEqual(check.warnings, []);
  assert.equal(check.writes, false);
  assert.equal(check.id, "flow-path-analyzer");
  assert.equal(check.name, "Flow Path Analyzer");
  validateTool(tool, "flow-path-analyzer.js");
  assert.equal(typeof tool.mount, "function");
  assert.match(src, /ctx\.junosShow\(/);
});

test("platform, hop items, paths and saved flows", () => {
  assert.equal(T.platformOf("switch", "EX4400"), "junos");
  assert.equal(T.platformOf("gateway", "SRX320"), "junos");
  assert.equal(T.platformOf("gateway", "SSR120"), "ssr");
  const sw = { mac: "020000000001", name: "sw1", model: "EX4400", type: "switch" };
  const gw = { mac: "020000000002", name: "gw1", model: "SSR120", type: "gateway" };
  const a = T.portItem(SITE, sw, { port_id: "ge-0/0/1", neighbor_mac: "02:00:00:00:00:02", neighbor_system_name: "gw1", neighbor_port_desc: "ge-0/0/3" });
  const b = T.portItem(SITE, gw, { port_id: "ge-0/0/3", neighbor_mac: "020000000001" });
  assert.equal(a.neighbourMac, "020000000002");
  assert.ok(T.sameLink(a, b));
  const rec = { mac: "020000000002", port_id: "ge-0/0/0", peer_mac: "020000000009", peer_port_id: "ge-0/0/0", peer_router_name: "gw9", peer_site_id: SITE2.id, type: "svr", up: true, latency: 20, jitter: 2, loss: 4, mos: 4.2, mtu: 1400, is_active: true, uptime: 4000, last_seen: 5 };
  const p = T.peerPathItem(SITE, gw, rec);
  assert.ok(T.matchesPath(p, rec));
  assert.equal(T.pickPath(p, [{ ...rec, last_seen: 1, loss: 0 }, rec]).loss, 4);
  const t = T.tunnelItem(SITE, gw, { tunnel_name: "zs-1", peer_ip: "198.51.100.1", wan_name: "wan0", node: "node0" });
  const hops = T.cleanFlow(JSON.parse(JSON.stringify({ kind: "mist-flow-path", org: "o", hops: [a, b, p, t, { junk: 1 }] })), "o");
  assert.deepEqual(hops.map((x) => x.key), [a.key, b.key, p.key, t.key]);
  assert.equal(hops[0].platform, "junos"); assert.equal(hops[1].platform, "ssr");
  assert.throws(() => T.cleanFlow({ kind: "mist-flow-path", org: "x", hops: [a] }, "o"), /different organization/);
  assert.throws(() => T.cleanFlow({ hops: [] }, "o"));
  const s = T.pathSample(p, rec);
  assert.equal(s.mtu, 1400); assert.equal(T.worstGauge(s), "crit");
  assert.equal(T.gaugeLevel("mos", 3.0), "crit"); assert.equal(T.gaugeLevel("latency", 10), "good");
});

test("rows, WAN gauges, health, SLE, next hop and the verdict", async () => {
  const j = junosJson(JSON.parse(await readFile(join(here, "fixtures", "junos-show-interfaces-extensive.json"), "utf8")));
  const iface = interfaceCounters(j)[0];
  const sw = { mac: "020000000001", name: "sw1", model: "EX4400", type: "switch" };
  const sw2 = { mac: "020000000003", name: "sw2", model: "EX4400", type: "switch" };
  const gw = { mac: "020000000002", name: "gw1", model: "SRX320", type: "gateway" };
  const a = T.portItem(SITE, sw, { port_id: "ge-0/0/1", neighbor_mac: "020000000003" });
  const b = T.portItem(SITE, sw2, { port_id: "ge-0/0/2", neighbor_mac: "020000000001" });
  const g = T.portItem(SITE, gw, { port_id: "ge-0/0/0" });
  const rec = { mac: gw.mac, port_id: "ge-0/0/0", peer_mac: "020000000009", peer_port_id: "ge-0/0/0", up: false, mtu: 1400 };
  const p = T.peerPathItem(SITE, gw, rec);
  const bump = (i, add) => ({ ...i, counters: Object.fromEntries(Object.entries(i.counters).map(([k, v]) => [k, v + (add[k] || 0)])) });
  const base = new Map([[a.key, { t: 1000, s: T.cliSample(iface) }], [b.key, { t: 1100, s: T.cliSample(iface) }]]);
  const cur = new Map([
    [a.key, { t: 6000, s: T.cliSample(bump(iface, { "traffic.output-packets": 100000 })) }],
    [b.key, { t: 6100, s: T.cliSample(bump(iface, { "traffic.input-packets": 90000, "mac.input-crc-errors": 7 })) }],
    [g.key, { t: 6000, s: T.restSample({ port_id: "ge-0/0/0", up: true, speed: 1000, full_duplex: true, rx_errors: 1, loss: 2, latency: 20, jitter: 1 }) }],
    [p.key, { t: 6000, s: T.pathSample(p, rec) }],
  ]);
  const rows = T.buildRows([a, b, g, p], cur, base);
  assert.equal(rows[1].newErrors, 7); assert.equal(rows[1].state, "errors");
  assert.equal(rows[2].state, "degraded"); assert.equal(rows[3].state, "down");
  const hl = T.deviceHealth({ status: "connected", model: "SRX320", cpu_stat: { idle: 5 }, memory_stat: { usage: 40 }, spu_stat: [{ spu_current_session: 900, spu_max_session: 1000 }], module_stat: [{ network_resources: [{ type: "FIB", count: 10, limit: 1000 }] }], is_ha: true, cluster_config: { status: "Red", last_status_change_reason: "fabric down" },
    if_stat: { "ge-0/0/0.0": { port_id: "ge-0/0/0", wan_name: "wan0", ips: ["203.0.113.2/30"], servp_info: { org: "Example ISP", asn: "64500" } } } });
  assert.equal(hl.cpu, 95); assert.equal(hl.tables[0].pct, 90);
  const v = T.flowVerdict(rows, new Map([[SITE.id + "|" + gw.mac, hl]]));
  const text = v.map((f) => f.level + " " + f.hop + " " + f.text).join("\n");
  assert.match(text, /crit 2 .*7 new errors/); assert.match(text, /warn 2 Between hop 1 and hop 2: 10,000 of 100,000/);
  assert.match(text, /crit 4 .*path is down/); assert.match(text, /warn 3 .*2% loss/); assert.match(text, /crit 3 gw1: CPU at 95%/);
  assert.match(text, /warn 3 gw1: Sessions table 90% full/); assert.match(text, /HA cluster status is Red \(fabric down\)/);
  assert.match(text, /info .*smallest MTU on the path is 1400/);
  assert.equal(v[0].level, "crit");
  assert.deepEqual(T.flowVerdict(T.buildRows([a], new Map([[a.key, cur.get(a.key)]]), base)), []);
  const info = T.ifInfo({ if_stat: { "ge-0/0/0.0": { port_id: "ge-0/0/0", wan_name: "wan0", ips: ["203.0.113.2/30"], servp_info: { org: "Example ISP" } } } }, "ge-0/0/0");
  assert.equal(info.isp, "Example ISP"); assert.equal(T.ifInfo({}, "x"), null);
  assert.deepEqual(T.flowErrors({ x: { "logical-interface": [{ "flow-error-statistics": { "no-route": 3, "policy-denied": 2 } }, { "flow-error-statistics": { "no-route": 1 } }] } }), { "no-route": 4, "policy-denied": 2 });
  assert.equal(T.cliSample(iface, { a: 2, b: 3 }).counters["flow.total-drops"], 5);
  const sc = T.sleScore({ sle: { samples: { total: [100, 100], degraded: [10, 0] } }, classifiers: [{ name: "network-jitter", samples: { degraded: [10] } }, { name: "x", samples: { degraded: [0] } }] });
  assert.equal(sc.score, 95); assert.equal(sc.classifiers.length, 1);
  const dev = T.findNeighbourDevice({ neighbor_system_name: "GW1.example.net" }, [{ mac: "020000000002", name: "gw1" }]);
  assert.equal(dev.mac, "020000000002");
  assert.equal(T.facingPorts([{ port_id: "ge-0/0/3", neighbor_mac: "020000000001", neighbor_port_desc: "ge-0/0/1" }, { port_id: "ge-0/0/4", neighbor_mac: "020000000001", neighbor_port_desc: "ge-0/0/9" }], a, {})[0].port_id, "ge-0/0/3");
});

const iface = async () => interfaceCounters(JSON.parse(await readFile(join(here, "fixtures", "junos-show-interfaces-extensive.json"), "utf8")))[0];

test("the counters follow show interfaces extensive, and every key is one the CLI returns", async () => {
  const keys = new Set(Object.keys((await iface()).counters));
  // flow.total-drops is the tool's own sum of the SRX flow-error statistics.
  for (const k of ALL_COUNTERS) if (k.key !== "flow.total-drops") assert.ok(keys.has(k.key), `${k.key} is not in the CLI reply`);
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
