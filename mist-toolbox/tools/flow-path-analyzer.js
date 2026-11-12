// Flow Path Analyzer - a Mist Provision Box tool (read-only).
//
// Follow a flow end to end: switch ports, WAN edge ports (SRX and SSR), the
// overlay peer path or WAN tunnel between two WAN edges, and the far WAN edge.
// Put the hops in order and watch them side by side; the verdict at the top
// names the hop that is losing traffic or picking up errors.
//
// Where the numbers come from:
//   * Switches and SRX run Junos, so their ports are read live from the device
//     CLI (`show interfaces extensive`, through ctx.junosShow) every few
//     seconds, with Mist's port stats as the fallback.
//   * SSR is not Junos; its ports come from Mist's port stats (about once a
//     minute, total errors only).
//   * WAN port latency / jitter / loss, peer paths, WAN tunnels, WAN edge
//     health (CPU, memory, sessions, tables, HA) and the 24 h WAN SLEs come
//     from Mist's stats, refreshed once a minute.
//
// Built in since 1.7.0, where it replaced Port Stats Correlator (switch ports
// only). The file still stands alone: it imports only lib/junos-shell.js, and
// its pure helpers are exported for tests/flow-path-analyzer.test.js.

import { interfaceCounters, junosJson } from "../lib/junos-shell.js";

const CELL = "white-space:nowrap;padding-right:1rem;";
const PANEL = "margin-top:1rem;";
const TITLE = "font-weight:600;font-size:1.02rem;margin:0 0 .85rem 0;";
const HINT = "font-size:12px;margin-top:.6rem;";
const EMPTY = "font-size:13px;font-style:italic;padding:.4rem 0;";
const BOX = "width:auto;min-height:auto;";
const CAPS = "font-size:11px;text-transform:uppercase;letter-spacing:.04em;";
const CLIP = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;";
const tint = (colour, pct) => "color-mix(in oklab, var(--" + colour + ") " + pct + "%, transparent)";
const linkClass = (v) => (v === "Up" ? "good" : v === "Down" ? "crit" : "warn");

const DEFAULT_SECS = 5;
const MIN_SECS = 2;
// Mist refreshes its own statistics about once a minute, so anything read from
// the REST stats is asked for at most this often per device. A WAN edge in the
// flow costs 2 to 4 API calls a minute; Mist allows 5,000 an hour per token.
export const REST_MS = 60 * 1000;
const MAX_FAILED_POLLS = 3;
const CLI_RETRY_MS = 60 * 1000;
const FLOW_FILE_KIND = "mist-flow-path";

/** When a value turns amber or red. Loss is a percentage, latency and jitter milliseconds. */
export const LIMITS = {
  loss: [1, 3],
  latency: [150, 300],
  jitter: [30, 60],
  mos: [3.6, 3.1],          // lower is worse
  cpu: [85, 95],
  memory: [85, 95],
  table: [80, 95],          // sessions, FIB, flow table: percent used
  linkLossPct: 1,           // packets sent by one end and not received by the other
  linkLossMin: 100,
};

// Small DOM builder. Text always goes in through textContent, never as HTML.
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null) continue;
    if (k === "text") el.textContent = String(v);
    else if (k === "style") el.style.cssText = v;
    else if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else el[k] = v;
  }
  for (const kid of kids.flat()) {
    if (kid === undefined || kid === null || kid === false) continue;
    el.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
  }
  return el;
}

function clear(el, ...kids) {
  while (el.firstChild) el.removeChild(el.firstChild);
  for (const kid of kids.flat()) if (kid) el.appendChild(kid);
}

const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
const fmtInt = (v) => (num(v) === null ? "" : Math.round(v).toLocaleString());
const fmt1 = (v) => (num(v) === null ? "" : (Math.round(v * 10) / 10).toLocaleString());
const clock = (ms) => new Date(ms).toLocaleTimeString();
const sum = (list) => (Array.isArray(list) ? list.reduce((n, v) => n + (num(v) || 0), 0) : 0);
const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");

export function fmtRate(v) {
  if (num(v) === null) return "";
  const units = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
  let n = v;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i += 1; }
  return (i === 0 ? String(Math.round(n)) : n.toFixed(n >= 100 ? 0 : 1)) + " " + units[i];
}

function fmtSpeed(v) {
  if (num(v) === null || v <= 0) return "";
  return v >= 1000 ? (v / 1000) + "G" : v + "M";
}

export function fmtUptime(secs) {
  if (num(secs) === null || secs < 0) return "";
  const d = Math.floor(secs / 86400);
  const hr = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return d ? d + "d " + hr + "h" : hr ? hr + "h " + m + "m" : m + "m";
}

const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });

/** A MAC as 12 lowercase hex digits, or "" when it is not one. */
export function normMac(v) {
  const hex = String(v || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  return hex.length === 12 ? hex : "";
}

/** Mist's device id for a device MAC. */
export const deviceIdFor = (mac) => "00000000-0000-0000-1000-" + normMac(mac);

/**
 * "junos" for a device whose CLI is Junos (every switch, and SRX), "ssr" for a
 * Session Smart Router. Only Junos devices are read over the CLI.
 */
export function platformOf(deviceType, model, pathType) {
  if (deviceType !== "gateway") return "junos";
  if (/srx/i.test(String(model || ""))) return "junos";
  if (!model && pathType === "ipsec") return "junos";
  return "ssr";
}

function neighbourOf(p) {
  if (!p) return "";
  const sys = p.neighbor_system_name || p.neighbor_mac || "";
  const port = p.neighbor_port_desc || "";
  return sys && port ? sys + " (" + port + ")" : sys || port;
}

// Mist can return more than one record for a port; keep the newest of each.
export function latestPerPort(records, mac) {
  const byPort = new Map();
  for (const r of records || []) {
    if (!r || !r.port_id) continue;
    if (mac && r.mac && String(r.mac).toLowerCase() !== mac) continue;
    const seen = byPort.get(r.port_id);
    if (!seen || (num(r.timestamp) || 0) >= (num(seen.timestamp) || 0)) byPort.set(r.port_id, r);
  }
  return [...byPort.values()].sort((a, b) => natural(a.port_id, b.port_id));
}

// ---- hops ---------------------------------------------------------------
// A hop is a port (on a switch or a WAN edge) or a path (an overlay peer path
// between two WAN edges, or a WAN tunnel that ends outside Mist).

export function portItem(site, dev, p) {
  return {
    key: site.id + "|" + dev.mac + "|" + p.port_id,
    kind: "port", siteId: site.id, siteName: site.name || "", mac: dev.mac, deviceName: dev.name || dev.mac,
    deviceType: dev.type === "gateway" ? "gateway" : "switch", model: dev.model || "",
    platform: platformOf(dev.type, dev.model, dev.pathType),
    portId: p.port_id, neighbour: neighbourOf(p), neighbourMac: normMac(p.neighbor_mac),
  };
}

/** The hop for one peer-path record (Mist's vpn_peers statistics). */
export function peerPathItem(site, dev, r) {
  const peerMac = normMac(r.peer_mac);
  return {
    key: "path|" + dev.mac + "|" + (r.port_id || "") + "|" + peerMac + "|" + (r.peer_port_id || ""),
    kind: "path", pathType: "peer", siteId: site.id, siteName: site.name || "", mac: dev.mac, deviceName: dev.name || dev.mac,
    deviceType: "gateway", model: dev.model || "", platform: platformOf("gateway", dev.model, r.type),
    portId: r.port_id || "", peerMac, peerPortId: r.peer_port_id || "", peerName: r.peer_router_name || peerMac,
    peerSiteId: r.peer_site_id || "", vpnType: r.type || "",
  };
}

/** The hop for one WAN tunnel record (Mist's tunnels statistics, type wan). */
export function tunnelItem(site, dev, r) {
  return {
    key: "tunnel|" + dev.mac + "|" + (r.tunnel_name || "") + "|" + (r.peer_ip || r.peer_host || "") + "|" + (r.node || ""),
    kind: "path", pathType: "tunnel", siteId: site.id, siteName: site.name || "", mac: dev.mac, deviceName: dev.name || dev.mac,
    deviceType: "gateway", model: dev.model || "", platform: platformOf("gateway", dev.model),
    portId: r.wan_name || "", tunnelName: r.tunnel_name || "", peerIp: r.peer_ip || "", peerName: r.peer_host || r.peer_ip || "",
    node: r.node || "",
  };
}

/** What the hop is called in tables and tiles. */
export function hopLabel(item) {
  if (item.kind !== "path") return item.portId;
  if (item.pathType === "tunnel") return "Tunnel " + (item.tunnelName || "") + " → " + (item.peerName || "");
  return (item.portId || "?") + " ⇄ " + (item.peerName || "") + (item.peerPortId ? " (" + item.peerPortId + ")" : "");
}

/** True when a record from Mist is the one this path hop was made from. */
export function matchesPath(item, r) {
  if (!r || normMac(r.mac) !== item.mac) return false;
  if (item.pathType === "tunnel") {
    return (r.tunnel_name || "") === item.tunnelName && (r.peer_ip || "") === item.peerIp && (r.node || "") === (item.node || "");
  }
  return (r.port_id || "") === item.portId && normMac(r.peer_mac) === item.peerMac && (r.peer_port_id || "") === item.peerPortId;
}

/** Keep a loaded flow file's hops only when they have the shape this tool writes. */
export function cleanFlow(data, orgId) {
  if (!data || data.kind !== FLOW_FILE_KIND || !Array.isArray(data.hops)) throw new Error("This is not a saved flow file.");
  if (data.org && orgId && data.org !== orgId) throw new Error("This flow was saved from a different organization.");
  const text = (v) => (typeof v === "string" ? v.slice(0, 200) : "");
  const hops = [];
  const seen = new Set();
  for (const raw of data.hops) {
    if (!raw || typeof raw !== "object") continue;
    const mac = normMac(raw.mac);
    const siteId = text(raw.siteId);
    if (!mac || !/^[0-9a-f-]{36}$/.test(siteId)) continue;
    const dev = { mac, name: text(raw.deviceName), model: text(raw.model), type: raw.deviceType === "gateway" ? "gateway" : "switch" };
    const site = { id: siteId, name: text(raw.siteName) };
    let item;
    if (raw.kind === "path" && raw.pathType === "tunnel") {
      item = tunnelItem(site, dev, { wan_name: text(raw.portId), tunnel_name: text(raw.tunnelName), peer_ip: text(raw.peerIp), peer_host: text(raw.peerName), node: text(raw.node) });
    } else if (raw.kind === "path") {
      item = peerPathItem(site, dev, { port_id: text(raw.portId), peer_mac: raw.peerMac, peer_port_id: text(raw.peerPortId), peer_router_name: text(raw.peerName), peer_site_id: text(raw.peerSiteId), type: text(raw.vpnType) });
    } else if (raw.kind === "port" && text(raw.portId)) {
      item = portItem(site, dev, { port_id: text(raw.portId), neighbor_mac: raw.neighbourMac });
      item.neighbour = text(raw.neighbour);
    }
    if (item && !seen.has(item.key)) { seen.add(item.key); hops.push(item); }
  }
  if (!hops.length) throw new Error("The flow file has no usable hops.");
  return hops;
}

// ---- counters -----------------------------------------------------------
// Laid out like "show interfaces extensive". Keys are the flat names
// lib/junos-shell.js interfaceCounters() gives ("in.input-errors"…). Mist's
// port stats fill only the few they have (see REST_FIELDS).
const c = (key, label, isError = true) => ({ key, label, isError });

export const INPUT_ERRORS = [
  c("in.input-errors", "Errors"),
  c("in.input-drops", "Drops"),
  c("in.framing-errors", "Framing errors"),
  c("in.input-runts", "Runts"),
  c("in.input-discards", "Policed discards"),
  c("in.input-l3-incompletes", "L3 incompletes"),
  c("in.input-l2-channel-errors", "L2 channel errors"),
  c("in.input-l2-mismatch-timeouts", "L2 mismatch timeouts"),
  c("in.input-fifo-errors", "FIFO errors"),
  c("in.input-resource-errors", "Resource errors"),
];

export const OUTPUT_ERRORS = [
  c("out.carrier-transitions", "Carrier transitions"),
  c("out.output-errors", "Errors"),
  c("out.output-collisions", "Collisions"),
  c("out.output-drops", "Drops"),
  c("out.aged-packets", "Aged packets"),
  c("out.output-fifo-errors", "FIFO errors"),
  c("out.hs-link-crc-errors", "HS link CRC errors"),
  c("out.mtu-errors", "MTU errors"),
  c("out.output-resource-errors", "Resource errors"),
];

export const MAC_ERRORS = [
  c("mac.input-crc-errors", "CRC/Align errors in"),
  c("mac.output-crc-errors", "CRC/Align errors out"),
  c("mac.input-fifo-errors", "MAC FIFO errors in"),
  c("mac.output-fifo-errors", "MAC FIFO errors out"),
  c("mac.input-oversized-frames", "Oversized frames"),
  c("mac.input-jabber-frames", "Jabber frames"),
  c("mac.input-fragment-frames", "Fragment frames"),
  c("mac.input-code-violations", "Code violations"),
  c("pcs.bit-error-seconds", "Bit error seconds"),
  c("pcs.errored-blocks-seconds", "Errored blocks seconds"),
  c("queue.total-drop-packets", "Queue drops (all queues)"),
  // SRX only: packets the firewall's flow module dropped on this interface.
  c("flow.total-drops", "Security flow drops (SRX)"),
];

export const TRAFFIC = [
  c("traffic.input-bytes", "Input bytes", false),
  c("traffic.output-bytes", "Output bytes", false),
  c("traffic.input-packets", "Input packets", false),
  c("traffic.output-packets", "Output packets", false),
  c("mac.input-mac-pause-frames", "Pause frames in", false),
  c("mac.output-mac-pause-frames", "Pause frames out", false),
];

export const ALL_COUNTERS = [...INPUT_ERRORS, ...OUTPUT_ERRORS, ...MAC_ERRORS, ...TRAFFIC];

const REST_FIELDS = {
  "in.input-errors": "rx_errors",
  "out.output-errors": "tx_errors",
  "traffic.input-bytes": "rx_bytes",
  "traffic.output-bytes": "tx_bytes",
  "traffic.input-packets": "rx_pkts",
  "traffic.output-packets": "tx_pkts",
};

/** Latency, jitter, loss and MOS from a Mist record, leaving out what it does not carry. */
export function gaugesOf(r) {
  const out = {};
  for (const k of ["latency", "jitter", "loss", "mos"]) if (num(r && r[k]) !== null) out[k] = r[k];
  return out;
}

/** "good", "warn" or "crit" for one gauge value; "" when there is nothing to judge. */
export function gaugeLevel(kind, v) {
  const lim = LIMITS[kind];
  if (!lim || num(v) === null) return "";
  if (kind === "mos") return v <= 0 ? "" : v < lim[1] ? "crit" : v < lim[0] ? "warn" : "good";
  return v >= lim[1] ? "crit" : v >= lim[0] ? "warn" : "good";
}

/**
 * SRX prints, per logical interface, the packets its flow module dropped
 * ("Flow error statistics"). Their JSON names vary by release, so this looks
 * for any "flow-error-statistics" container and adds up the numbers in it.
 * Returns {} on a switch, which has none.
 */
export function flowErrors(node, out = {}, depth = 0) {
  if (!node || typeof node !== "object" || depth > 8) return out;
  for (const [k, v] of Object.entries(node)) {
    if (/flow-error-statistics/.test(k)) {
      for (const part of Array.isArray(v) ? v : [v]) {
        if (!part || typeof part !== "object") continue;
        for (const [name, n] of Object.entries(part)) if (typeof n === "number") out[name] = (out[name] || 0) + n;
      }
    } else if (v && typeof v === "object") flowErrors(v, out, depth + 1);
  }
  return out;
}

/**
 * One sample of one hop, whatever it came from, in the same shape:
 * { src: "cli"|"rest"|"path", up, speed, duplex, mtu, rxBps, txBps, counters,
 *   gauges, info, raw, at }
 */
export function cliSample(iface, flow) {
  const counters = { ...(iface.counters || {}) };
  const drops = Object.entries(flow || {});
  for (const [k, v] of drops) counters["flow." + k] = v;
  if (drops.length) counters["flow.total-drops"] = drops.reduce((n, [, v]) => n + v, 0);
  return {
    src: "cli",
    up: String(iface.operStatus).toLowerCase() === "up",
    speed: String(iface.speed || "").replace(/mbps$/i, "M").replace(/gbps$/i, "G"),
    duplex: String(iface.linkMode || "").replace(/-duplex$/i, " duplex").toLowerCase(),
    mtu: num(iface.mtu),
    rxBps: num(counters["traffic.input-bps"]),
    txBps: num(counters["traffic.output-bps"]),
    counters, gauges: {}, info: {}, raw: iface, at: null,
  };
}

export function restSample(p) {
  const counters = {};
  for (const [key, field] of Object.entries(REST_FIELDS)) if (num(p[field]) !== null) counters[key] = p[field];
  return {
    src: "rest",
    up: !!p.up,
    speed: fmtSpeed(p.speed),
    duplex: typeof p.full_duplex === "boolean" ? (p.full_duplex ? "full duplex" : "half duplex") : "",
    mtu: null,
    rxBps: num(p.rx_bps),
    txBps: num(p.tx_bps),
    counters, gauges: gaugesOf(p), info: {}, raw: p, at: num(p.timestamp),
  };
}

/** A sample of a path hop, from a peer-path or a WAN tunnel record. */
export function pathSample(item, r) {
  const counters = {};
  if (item.pathType === "tunnel") {
    for (const [key, field] of Object.entries(REST_FIELDS)) if (num(r[field]) !== null) counters[key] = r[field];
  }
  return {
    src: "path",
    up: !!r.up,
    speed: "", duplex: "",
    mtu: num(r.mtu),
    rxBps: null, txBps: null,
    counters, gauges: gaugesOf(r),
    info: {
      active: typeof r.is_active === "boolean" ? r.is_active : null,
      uptime: num(r.uptime),
      type: r.type || r.protocol || "",
      lastEvent: r.last_event || "",
      priority: r.priority || "",
    },
    raw: r, at: num(r.last_seen),
  };
}

/** The newest record for a path hop among what Mist returned. */
export function pickPath(item, records) {
  let best = null;
  for (const r of records || []) {
    if (!matchesPath(item, r)) continue;
    if (!best || (num(r.last_seen) || 0) >= (num(best.last_seen) || 0)) best = r;
  }
  return best;
}

// Movement of one counter since the baseline. A counter that went backwards
// was cleared on the device in between, so it is reported as "reset".
export function diff(now, before) {
  if (num(now) === null || num(before) === null) return null;
  return now < before ? "reset" : now - before;
}

const showDelta = (d) => (d === "reset" ? "reset" : num(d) === null || d === 0 ? "" : "+" + fmtInt(d));

/** The worst gauge level on a sample: "crit", "warn" or "". */
export function worstGauge(s) {
  let worst = "";
  for (const [k, v] of Object.entries((s && s.gauges) || {})) {
    const lvl = gaugeLevel(k, v);
    if (lvl === "crit") return "crit";
    if (lvl === "warn") worst = "warn";
  }
  return worst;
}

/**
 * The rows the view and the exports draw from. `cur` and `base` map a hop key
 * to { t, s } (time, sample). Deltas are only worked out between samples from
 * the same source: CLI and Mist counters do not line up.
 */
export function buildRows(flow, cur, base) {
  return flow.map((item, i) => {
    const now = cur.get(item.key);
    const b = base.get(item.key);
    const s = now ? now.s : null;
    const row = { hop: i + 1, item, s, t: now ? now.t : null, baseT: null, vals: {}, since: null, newErrors: 0, state: "ok" };
    const compare = now && b && b.t !== now.t && b.s.src === now.s.src;
    if (compare) { row.since = b.t; row.baseT = b.t; }
    for (const k of ALL_COUNTERS) {
      const v = s ? num(s.counters[k.key]) : null;
      const d = compare ? diff(v, num(b.s.counters[k.key])) : null;
      row.vals[k.key] = { v, d };
      if (k.isError && num(d) !== null && d > 0) row.newErrors += d;
    }
    if (!s) row.state = "nodata";
    else if (row.newErrors > 0) row.state = "errors";
    else if (!s.up) row.state = "down";
    else if (worstGauge(s)) row.state = "degraded";
    return row;
  });
}

/** The smallest MTU along the flow, and the hops that have it. */
export function smallestMtu(rows) {
  const known = rows.filter((r) => r.s && num(r.s.mtu) !== null && r.s.mtu > 0);
  if (!known.length) return null;
  const mtu = Math.min(...known.map((r) => r.s.mtu));
  const largest = Math.max(...known.map((r) => r.s.mtu));
  return { mtu, hops: known.filter((r) => r.s.mtu === mtu).map((r) => r.hop), uniform: mtu === largest };
}

/** True when a CLI failure means "never on this device with this token". */
export const isRefusal = (message) => /\b403\b|admin-level/.test(String(message));

// ---- WAN edge health ----------------------------------------------------

const pct = (count, limit) => (num(count) !== null && num(limit) !== null && limit > 0 ? (count / limit) * 100 : null);

/**
 * The health of one WAN edge, from its record in Mist's device statistics.
 * Every part is null or empty when Mist did not send it, so the view only
 * shows what the device reports.
 */
export function deviceHealth(stat) {
  const st = stat || {};
  const cpuStat = st.cpu_stat || {};
  const cpu = num(cpuStat.usage) !== null ? cpuStat.usage : num(cpuStat.idle) !== null ? 100 - cpuStat.idle : null;
  const spu = (Array.isArray(st.spu_stat) ? st.spu_stat : []).find((x) => x && typeof x === "object") || {};
  const tables = [];
  if (num(spu.spu_max_session) !== null && spu.spu_max_session > 0) {
    tables.push({ label: "Sessions", count: num(spu.spu_current_session), limit: spu.spu_max_session });
  }
  for (const mod of Array.isArray(st.module_stat) ? st.module_stat : []) {
    for (const r of (mod && Array.isArray(mod.network_resources)) ? mod.network_resources : []) {
      if (r && num(r.limit) !== null && r.limit > 0) tables.push({ label: String(r.type || "table"), count: num(r.count), limit: r.limit });
    }
  }
  const routes = st.route_summary_stats || {};
  if (num(routes.max_unicast_routes_supported) !== null && routes.max_unicast_routes_supported > 0 && num(routes.total_routes) !== null) {
    tables.push({ label: "Routes", count: routes.total_routes, limit: routes.max_unicast_routes_supported });
  }
  const arp = st.arp_table_stats || {};
  if (num(arp.max_entries_supported) !== null && arp.max_entries_supported > 0 && num(arp.arp_table_count) !== null) {
    tables.push({ label: "ARP", count: arp.arp_table_count, limit: arp.max_entries_supported });
  }
  for (const t of tables) t.pct = pct(t.count, t.limit);
  const cc = st.cluster_config || {};
  const ha = (st.is_ha || cc.status || cc.operational) ? {
    status: cc.status || (st.cluster_stat && st.cluster_stat.state) || "",
    mode: cc.operational || cc.configuration || "",
    reason: cc.last_status_change_reason || "",
    control: (cc.control_link_info && cc.control_link_info.status) || "",
    fabric: (cc.fabric_link_info && cc.fabric_link_info.Status) || "",
  } : null;
  return {
    status: st.status || "", model: st.model || "", version: st.version || "", uptime: num(st.uptime),
    cpu, memory: num(st.memory_stat && st.memory_stat.usage), spuCpu: num(spu.spu_cpu),
    tables, ha, config: st.config_status || "", extIp: st.ext_ip || "",
  };
}

/** What Mist knows about one interface of a WAN edge: WAN name, addresses, ISP. */
export function ifInfo(stat, portId) {
  const all = (stat && stat.if_stat) || {};
  const hits = Object.entries(all).filter(([k, v]) => v && (k === portId || v.port_id === portId || k.startsWith(portId + ".")));
  if (!hits.length) return null;
  const pick = (hits.find(([, v]) => v.wan_name || v.servp_info) || hits[0])[1];
  const isp = pick.servp_info || {};
  return {
    wanName: pick.wan_name || "", wanType: pick.wan_type || "", usage: pick.port_usage || "",
    network: pick.network_name || "",
    ips: [...new Set(hits.flatMap(([, v]) => (Array.isArray(v.ips) ? v.ips : [])))],
    nat: [...new Set(hits.flatMap(([, v]) => (Array.isArray(v.nat_addresses) ? v.nat_addresses : [])))],
    isp: isp.org || "", asn: isp.asn || "",
    redundancy: pick.redundancy_state || "",
  };
}

/** A WAN SLE over its window: score (percent good) and the classifiers that cost the most. */
export function sleScore(resp) {
  const s = resp && resp.sle && resp.sle.samples;
  const total = sum(s && s.total);
  const degraded = sum(s && s.degraded);
  const classifiers = ((resp && resp.classifiers) || [])
    .map((cl) => ({ label: String(cl.name || ""), degraded: sum(cl.samples && cl.samples.degraded) }))
    .filter((cl) => cl.degraded > 0)
    .sort((a, b) => b.degraded - a.degraded);
  return { score: total > 0 ? Math.max(0, (1 - degraded / total) * 100) : null, classifiers };
}

// ---- next hop -----------------------------------------------------------

/** The Mist device an LLDP neighbour is, looked up by chassis MAC and then by name. */
export function findNeighbourDevice(port, devices) {
  if (!port) return null;
  const mac = normMac(port.neighbor_mac);
  const list = [...devices];
  const short = (v) => String(v || "").toLowerCase().split(".")[0];
  const sys = short(port.neighbor_system_name);
  return list.find((d) => mac && d.mac === mac)
    || (sys ? list.find((d) => short(d.name) === sys || short(d.hostname) === sys) : null)
    || null;
}

/**
 * The ports on the neighbour that face `item`: the ones whose own LLDP
 * neighbour is item's device, best match first (the one naming item's port),
 * or failing that the port LLDP named on our side.
 */
export function facingPorts(neighbourPorts, item, port) {
  const back = (neighbourPorts || []).filter((p) => normMac(p.neighbor_mac) === item.mac);
  const exact = back.filter((p) => String(p.neighbor_port_desc || "").includes(item.portId));
  if (exact.length) return exact;
  if (back.length) return back;
  const named = String((port && port.neighbor_port_desc) || "");
  return (neighbourPorts || []).filter((p) => named && p.port_id === named);
}

// ---- verdict ------------------------------------------------------------

/** Two neighbouring port hops are the two ends of one cable when LLDP on either names the other. */
export function sameLink(a, b) {
  if (!a || !b || a.kind !== "port" || b.kind !== "port" || a.mac === b.mac) return false;
  return (!!a.neighbourMac && a.neighbourMac === b.mac) || (!!b.neighbourMac && b.neighbourMac === a.mac);
}

function linkLoss(a, b) {
  // Packets a sent against packets b received since the baseline. Only for
  // two CLI samples: Mist's stats arrive a minute apart and never line up.
  if (!a.s || !b.s || a.s.src !== "cli" || b.s.src !== "cli" || !a.since || !b.since) return null;
  const sent = a.vals["traffic.output-packets"].d;
  const got = b.vals["traffic.input-packets"].d;
  if (num(sent) === null || num(got) === null || sent <= 0) return null;
  // The two ports are read a moment apart; allow for what flowed in between.
  const skewSecs = (Math.abs(a.t - b.t) + Math.abs(a.baseT - b.baseT)) / 1000;
  const pps = num(a.s.counters["traffic.output-pps"]) || 0;
  const allow = Math.max(LIMITS.linkLossMin, sent * (LIMITS.linkLossPct / 100), 2 * pps * skewSecs);
  const lost = sent - got;
  return lost > allow ? { lost, sent, pct: (lost / sent) * 100 } : null;
}

/**
 * What is wrong along the flow, worst first: [{ level, hop, text }], with
 * level "crit", "warn" or "info". `health` maps "site|mac" to deviceHealth().
 */
export function flowVerdict(rows, health = new Map()) {
  const out = [];
  const add = (level, hop, text) => out.push({ level, hop, text });
  const seenDevice = new Set();
  rows.forEach((r, i) => {
    const what = r.item.deviceName + " " + hopLabel(r.item);
    const s = r.s;
    if (!s) { add("warn", r.hop, what + ": no statistics yet."); return; }
    if (!s.up) add("crit", r.hop, what + (r.item.kind === "path" ? ": the path is down" + (s.info.lastEvent ? " (" + s.info.lastEvent + ")." : ".") : ": the link is down."));
    if (r.newErrors > 0) {
      const top = ALL_COUNTERS.filter((k) => k.isError && num(r.vals[k.key].d) > 0)
        .sort((x, y) => r.vals[y.key].d - r.vals[x.key].d).slice(0, 3)
        .map((k) => k.label + " +" + fmtInt(r.vals[k.key].d));
      add("crit", r.hop, what + ": " + fmtInt(r.newErrors) + " new errors or drops since the baseline (" + top.join(", ") + ").");
    }
    const units = { loss: "% loss", latency: " ms latency", jitter: " ms jitter", mos: " MOS" };
    for (const [k, v] of Object.entries(s.gauges || {})) {
      const lvl = gaugeLevel(k, v);
      if (lvl === "crit" || lvl === "warn") add(lvl, r.hop, what + ": " + fmt1(v) + units[k] + ".");
    }
    if (r.item.kind === "path" && s.up && s.info.active === false) add("info", r.hop, what + ": the path is up but is not the active one.");

    const next = rows[i + 1];
    if (next && next.s && sameLink(r.item, next.item)) {
      for (const [from, to] of [[r, next], [next, r]]) {
        const loss = linkLoss(from, to);
        if (loss) {
          add("warn", to.hop, "Between hop " + from.hop + " and hop " + to.hop + ": " + fmtInt(loss.lost) + " of " + fmtInt(loss.sent)
            + " packets sent by " + from.item.deviceName + " " + from.item.portId + " did not arrive at " + to.item.deviceName + " " + to.item.portId
            + " (" + fmt1(loss.pct) + "%).");
        }
      }
      if (s.up && next.s.up) {
        if (s.speed && next.s.speed && s.speed !== next.s.speed) add("warn", next.hop, "Hop " + r.hop + " and hop " + next.hop + " are the two ends of one link but report different speeds (" + s.speed + " and " + next.s.speed + ").");
        if (s.duplex && next.s.duplex && s.duplex !== next.s.duplex) add("warn", next.hop, "Hop " + r.hop + " and hop " + next.hop + " are the two ends of one link but report different duplex (" + s.duplex + " and " + next.s.duplex + ").");
        if (num(s.mtu) !== null && num(next.s.mtu) !== null && s.mtu !== next.s.mtu) add("warn", next.hop, "Hop " + r.hop + " and hop " + next.hop + " are the two ends of one link but have different MTUs (" + s.mtu + " and " + next.s.mtu + ").");
      }
    }

    const devKey = r.item.siteId + "|" + r.item.mac;
    const hl = health.get(devKey);
    if (hl && !seenDevice.has(devKey)) {
      seenDevice.add(devKey);
      const dev = r.item.deviceName;
      const level = (v, lim) => (num(v) === null ? "" : v >= lim[1] ? "crit" : v >= lim[0] ? "warn" : "");
      if (level(hl.cpu, LIMITS.cpu)) add(level(hl.cpu, LIMITS.cpu), r.hop, dev + ": CPU at " + fmt1(hl.cpu) + "%.");
      if (level(hl.memory, LIMITS.memory)) add(level(hl.memory, LIMITS.memory), r.hop, dev + ": memory at " + fmt1(hl.memory) + "%.");
      for (const t of hl.tables) {
        if (level(t.pct, LIMITS.table)) add(level(t.pct, LIMITS.table), r.hop, dev + ": " + t.label + " table " + fmt1(t.pct) + "% full (" + fmtInt(t.count) + " of " + fmtInt(t.limit) + ").");
      }
      if (hl.ha && hl.ha.status && !/^(green|healthy|ok|good|up|primary|secondary|active|standby|running)$/i.test(hl.ha.status)) {
        add("warn", r.hop, dev + ": HA cluster status is " + hl.ha.status + (hl.ha.reason ? " (" + hl.ha.reason + ")." : "."));
      }
      if (hl.status && hl.status !== "connected") add("warn", r.hop, dev + ": Mist shows the device as " + hl.status + ".");
    }
  });
  const mtu = smallestMtu(rows);
  if (mtu && !mtu.uniform) add("info", mtu.hops[0], "The smallest MTU on the path is " + mtu.mtu + ", at hop " + mtu.hops.join(", ") + ". Larger packets need fragmenting or are dropped there.");
  const rank = { crit: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level] || a.hop - b.hop);
}

// ---- view parts ---------------------------------------------------------

const STATE_COLOUR = { ok: "var(--good)", errors: "var(--crit)", down: "var(--crit)", degraded: "var(--warn)", nodata: "var(--subtle)" };

function scrollBox(maxHeight, table) {
  return h("div", { style: "overflow:auto;max-height:" + maxHeight + ";" }, table);
}

function tableOf(headers, bodyRows) {
  return h("table", { className: "ap-table" },
    h("thead", null, h("tr", null, headers.map((t) => h("th", { style: CELL, text: t })))),
    h("tbody", null, bodyRows));
}

function tile(value, label, colour) {
  return h("div", { style: "border:1px solid var(--border);border-top:4px solid " + colour + ";border-radius:6px;padding:8px 10px;" },
    h("b", { style: "display:block;font-size:22px;", text: value }),
    h("span", { className: "muted", style: "font-size:12px;", text: label }));
}

function counterLine(k, cell, src) {
  const missing = num(cell.v) === null;
  const grew = num(cell.d) !== null && cell.d > 0;
  const hot = k.isError && grew;
  const why = src === "cli" ? "The device does not report this counter" : "Only a Junos device's CLI reports this counter";
  return h("div", { style: "display:flex;justify-content:space-between;gap:.5rem;padding:1px 0;font-size:12.5px;" + (hot ? "font-weight:600;" : "") },
    h("span", { className: hot ? "crit" : "muted", style: CLIP, title: k.label, text: k.label }),
    h("span", { style: "white-space:nowrap;font-variant-numeric:tabular-nums;" },
      h("span", { className: missing ? "subtle" : hot ? "crit" : cell.v === 0 ? "muted" : "", text: missing ? "—" : fmtInt(cell.v), title: missing ? why : "" }),
      showDelta(cell.d) ? h("span", { className: cell.d === "reset" ? "warn" : hot ? "crit" : "accent", style: "margin-left:.4rem;", text: showDelta(cell.d) }) : null));
}

function counterBlock(title, list, row) {
  return h("div", { style: "min-width:0;" },
    h("div", { className: "subtle", style: CAPS + "margin-bottom:.25rem;", text: title }),
    list.map((k) => counterLine(k, row.vals[k.key], row.s && row.s.src)));
}

const COLS = "display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 1.1rem;";
const RULE = "margin-top:.5rem;padding-top:.5rem;border-top:1px solid var(--border);";

function stat(label, value, level) {
  return h("div", { style: "min-width:0;" },
    h("span", { className: "subtle", style: CAPS, text: label + "  " }),
    h("b", { className: level === "good" ? "" : level || "", text: value || "—" }));
}

// Latency, jitter, loss and MOS, when Mist sent them for this hop.
function gaugeRow(s) {
  const g = s.gauges || {};
  const parts = [
    ["loss", "Loss", (v) => fmt1(v) + " %"], ["latency", "Latency", (v) => fmt1(v) + " ms"],
    ["jitter", "Jitter", (v) => fmt1(v) + " ms"], ["mos", "MOS", (v) => fmt1(v)],
  ].filter(([k]) => num(g[k]) !== null);
  if (!parts.length) return null;
  return h("div", { style: "display:grid;grid-template-columns:repeat(" + Math.min(parts.length, 4) + ",minmax(0,1fr));gap:0 .8rem;font-size:13px;margin-bottom:.5rem;" },
    parts.map(([k, label, show]) => stat(label, show(g[k]), gaugeLevel(k, g[k]))));
}

// CPU, memory, tables and HA of the WAN edge a hop is on.
function healthStrip(hl, info, sle) {
  if (!hl && !info && !sle) return null;
  const lvl = (v, lim) => (num(v) === null ? "" : v >= lim[1] ? "crit" : v >= lim[0] ? "warn" : "");
  const bits = [];
  if (hl) {
    if (num(hl.cpu) !== null) bits.push(stat("CPU", fmt1(hl.cpu) + " %", lvl(hl.cpu, LIMITS.cpu)));
    if (num(hl.memory) !== null) bits.push(stat("Memory", fmt1(hl.memory) + " %", lvl(hl.memory, LIMITS.memory)));
    for (const t of hl.tables) bits.push(stat(t.label, fmtInt(t.count) + " / " + fmtInt(t.limit), lvl(t.pct, LIMITS.table)));
    if (hl.ha) bits.push(stat("HA", [hl.ha.status, hl.ha.mode].filter(Boolean).join(" · ")));
    if (hl.config) bits.push(stat("Config", hl.config));
    if (num(hl.uptime) !== null) bits.push(stat("Uptime", fmtUptime(hl.uptime)));
  }
  const wan = info ? [info.wanName && "WAN " + info.wanName, info.wanType, info.isp && "ISP " + info.isp + (info.asn ? " (AS" + String(info.asn).replace(/^AS/i, "") + ")" : ""),
    info.ips.length ? info.ips.join(", ") : "", info.nat.length ? "NAT " + info.nat.join(", ") : "", info.redundancy].filter(Boolean).join("  ·  ") : "";
  return h("div", { style: RULE },
    h("div", { className: "subtle", style: CAPS + "margin-bottom:.25rem;", text: "WAN edge" + (hl && hl.model ? "  ·  " + hl.model + (hl.version ? " " + hl.version : "") : "") }),
    wan ? h("div", { className: "muted", style: "font-size:12px;margin-bottom:.3rem;overflow-wrap:anywhere;", text: wan }) : null,
    bits.length ? h("div", { style: "display:grid;grid-template-columns:repeat(auto-fill,minmax(8.5rem,1fr));gap:.15rem .8rem;font-size:12.5px;" }, bits) : null,
    sle ? h("div", { style: "font-size:12.5px;margin-top:.35rem;" },
      h("span", { className: "subtle", style: CAPS, text: "Last 24 h  " }),
      sle.error ? h("span", { className: "muted", text: sle.error })
        : sle.metrics.map((m) => h("span", { style: "margin-right:.9rem;", title: m.classifiers.map((cl) => cl.label).join(", ") },
          m.label + " ", h("b", { className: m.score === null ? "subtle" : m.score < 90 ? "crit" : m.score < 98 ? "warn" : "good", text: m.score === null ? "—" : fmt1(m.score) + " %" }),
          m.classifiers.length ? h("span", { className: "muted", text: " (" + m.classifiers.slice(0, 2).map((cl) => cl.label).join(", ") + ")" }) : null))) : null);
}

/** A sample as flat name -> text, for the raw view and the "All fields" sheet. */
export function rawRecord(s) {
  if (!s) return {};
  const show = (v) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const out = {};
  if (s.src === "cli") {
    const r = s.raw;
    for (const k of ["name", "description", "adminStatus", "operStatus", "mtu", "speed", "linkMode", "autoneg", "partnerSpeed", "flapped", "cleared"]) out[k] = show(r[k]);
    for (const [k, v] of Object.entries(s.counters)) out[k] = show(v);
    for (const q of r.queues || []) out["queue " + q.number + " " + q.name + " drops"] = show(q.drops);
  } else {
    for (const [k, v] of Object.entries(s.raw)) out[k] = show(v);
  }
  return out;
}

function rawFields(row, openRaw) {
  const flat = rawRecord(row.s);
  const keys = Object.keys(flat).sort();
  const box = h("details", { open: openRaw.has(row.item.key), style: "margin-top:.45rem;font-size:12px;" },
    h("summary", { className: "muted", style: "cursor:pointer;", text: "All " + keys.length + " fields " + (row.s.src === "cli" ? "the device" : "Mist") + " returned for this hop" }),
    h("div", { style: "margin-top:.35rem;max-height:14rem;overflow-y:auto;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;" },
      keys.map((k) => h("div", { style: "display:flex;justify-content:space-between;gap:.75rem;padding:1px 0;" },
        h("span", { className: "muted", text: k }),
        h("span", { style: "text-align:right;overflow-wrap:anywhere;min-width:0;", text: flat[k] })))));
  box.addEventListener("toggle", () => { if (box.open) openRaw.add(row.item.key); else openRaw.delete(row.item.key); });
  return box;
}

function tileShell(row, headRight, sub, body) {
  const bg = row.state === "errors" || (row.state === "down" && row.item.kind === "path") ? "background:" + tint("crit", 7) + ";" : "";
  const kind = row.item.kind === "path" ? (row.item.pathType === "tunnel" ? "WAN tunnel" : "Peer path") : row.item.deviceType === "gateway" ? "WAN edge" : "Switch";
  return h("div", { style: "border:1px solid var(--border);border-left:5px solid " + STATE_COLOUR[row.state] + ";border-radius:6px;padding:10px 12px;min-width:0;" + bg },
    h("div", { style: "display:flex;justify-content:space-between;gap:.6rem;align-items:baseline;" },
      h("div", { style: CLIP + "font-weight:600;font-size:14px;" },
        h("span", { className: "accent", text: row.hop + "  " }), row.item.deviceName + "  ", h("span", { text: hopLabel(row.item) })),
      headRight),
    h("div", { className: "muted", style: CLIP + "font-size:12px;margin-bottom:.5rem;" },
      h("span", { className: "pill", style: "margin-right:.4rem;", text: kind }), sub),
    body);
}

function freshness(row, ctx) {
  const s = row.s;
  const from = s.src === "cli" ? "Read from the device CLI at " + clock(row.t)
    : "Mist stats" + (num(s.at) !== null ? " from " + ctx.fmtTime(s.at) : ", read at " + clock(row.t))
      + (row.item.kind === "port" ? (row.item.platform === "ssr" ? " (SSR has no Junos CLI)" : " (device CLI not available)") : "");
  return h("div", { className: "subtle", style: "font-size:11px;margin-top:.45rem;", text:
    [row.since ? "Change since " + clock(row.since) : "Baseline sample", from].filter(Boolean).join("  ·  ") });
}

function portTile(row, ctx, openRaw, extra) {
  const s = row.s;
  const link = s ? (s.up ? "Up" : "Down") : "No data";
  const meta = s ? [s.speed, s.duplex, s.mtu ? "MTU " + s.mtu : ""].filter(Boolean).join(" · ") : "";
  const half = (list) => Math.ceil(list.length / 2);
  const head = h("span", { style: "white-space:nowrap;font-size:12px;font-weight:600;" },
    h("span", { className: linkClass(link), text: link }), meta ? h("span", { className: "muted", style: "font-weight:400;", text: "  " + meta }) : null);
  const sub = [row.item.siteName, row.item.neighbour].filter(Boolean).join("  →  ");
  const shown = (list) => (s && s.src === "cli" ? list.filter((k) => !k.key.startsWith("flow.") || num(row.vals[k.key].v) !== null) : list.filter((k) => !k.key.startsWith("flow.")));
  const mac = shown(MAC_ERRORS);
  return tileShell(row, head, sub, !s ? h("div", { className: "muted", style: EMPTY, text: "No statistics for this port yet." }) : [
    h("div", { style: COLS + "font-size:13px;margin-bottom:.5rem;" }, stat("Rx rate", fmtRate(s.rxBps)), stat("Tx rate", fmtRate(s.txBps))),
    gaugeRow(s),
    h("div", { style: COLS }, counterBlock("Input errors", INPUT_ERRORS, row), counterBlock("Output errors", OUTPUT_ERRORS, row)),
    h("div", { style: COLS + RULE }, counterBlock("MAC / PCS / queues", mac.slice(0, half(mac)), row), counterBlock("", mac.slice(half(mac)), row)),
    h("div", { style: COLS + RULE }, counterBlock("Traffic", TRAFFIC.filter((k, i) => i % 2 === 0), row), counterBlock("", TRAFFIC.filter((k, i) => i % 2 === 1), row)),
    extra,
    freshness(row, ctx),
    rawFields(row, openRaw),
  ]);
}

function pathTile(row, ctx, openRaw) {
  const s = row.s;
  const link = s ? (s.up ? "Up" : "Down") : "No data";
  const head = h("span", { style: "white-space:nowrap;font-size:12px;font-weight:600;" },
    h("span", { className: linkClass(link), text: link }),
    s && s.info.active !== null ? h("span", { className: "muted", style: "font-weight:400;", text: s.info.active ? "  · active" : "  · standby" }) : null,
    s && s.mtu ? h("span", { className: "muted", style: "font-weight:400;", text: "  · MTU " + s.mtu }) : null);
  const sub = [row.item.siteName, row.item.pathType === "tunnel" ? row.item.peerIp : row.item.peerName].filter(Boolean).join("  →  ");
  const tunnel = row.item.pathType === "tunnel";
  return tileShell(row, head, sub, !s ? h("div", { className: "muted", style: EMPTY, text: "Mist has no statistics for this path yet." }) : [
    gaugeRow(s) || h("div", { className: "muted", style: "font-size:12.5px;margin-bottom:.5rem;", text: "Mist reports no latency, jitter or loss for this path." }),
    h("div", { style: "display:grid;grid-template-columns:repeat(auto-fill,minmax(8.5rem,1fr));gap:.15rem .8rem;font-size:12.5px;" },
      stat("Type", s.info.type), stat("Up for", fmtUptime(s.info.uptime)),
      s.info.priority ? stat("Priority", s.info.priority) : null,
      s.info.lastEvent ? stat("Last event", s.info.lastEvent) : null),
    tunnel ? h("div", { style: COLS + RULE }, counterBlock("Traffic", TRAFFIC.slice(0, 4).filter((k, i) => i % 2 === 0), row), counterBlock("", TRAFFIC.slice(0, 4).filter((k, i) => i % 2 === 1), row)) : null,
    freshness(row, ctx),
    rawFields(row, openRaw),
  ]);
}

async function toBlob(made) {
  const out = await made;
  const type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (typeof Blob !== "undefined" && out instanceof Blob) return out;
  if (out instanceof ArrayBuffer || ArrayBuffer.isView(out)) return new Blob([out], { type });
  throw new Error("the toolbox did not return a workbook file");
}

export default {
  id: "flow-path-analyzer",
  name: "Flow Path Analyzer",
  description: "Follow a flow end to end: switch ports, WAN edge ports (SRX and SSR), overlay peer paths and WAN tunnels, side by side in hop order. Live interface counters from the Junos CLI, WAN latency, jitter and loss, WAN edge health, and a verdict that names the hop with the problem.",
  tag: "Mist API · device CLI",
  level: "Site · Org",
  needs: { mistToken: true, org: true },
  params: [],

  // The toolbox insists on a run function. This tool works from its own view
  // (mount, below), so run only points the user there.
  async run(ctx) {
    if (ctx && ctx.log) ctx.log("Use the picker: add hops to the flow and the statistics refresh by themselves.", "info");
    return { summary: "Add hops to the flow in the picker; the statistics then refresh by themselves." };
  },

  async mount(ctx) {
    const root = ctx.mount;
    const log = (m, kind) => { if (ctx.log) ctx.log(m, kind || "info"); };

    const state = {
      sites: [],
      siteId: "",
      devType: "switch",     // what the device list shows: "switch" or "gateway"
      devices: [],           // devices of that type at the chosen site
      mac: "",
      ports: [],             // ports on the chosen device
      ticked: new Set(),
      filter: "",
      upOnly: false,
      flow: [],              // hops, in order
      cur: new Map(),        // key -> { t, s } latest sample
      base: new Map(),       // key -> { t, s } baseline the deltas are measured from
      auto: true,
      useCli: true,
      secs: DEFAULT_SECS,
      busy: false,
      polls: 0,
      failedPolls: 0,
      lastUpdate: null,
      note: "",
      next: null,            // next-hop suggestions: { message, options: [{ label, items }] }
    };
    const portCache = new Map();   // "site|mac" -> ports
    const openRaw = new Set();
    const cliDown = new Map();     // "site|mac" -> { refused, until, reason }
    const restAt = new Map();      // "site|mac" -> when its Mist stats were last read
    const gwStat = new Map();      // "site|mac" -> the WAN edge's record in Mist's device stats
    const health = new Map();      // "site|mac" -> deviceHealth()
    const sle = new Map();         // "site|mac" -> { metrics } | { error }
    const warned = new Set();
    let orgIndex = null;           // Promise<Map mac -> device>, the org's switches and WAN edges
    let timer = null;

    // ---- elements -------------------------------------------------------
    const siteSel = h("select", { title: "Site", on: { change: () => chooseSite(siteSel.value) } });
    const typeSel = h("select", { title: "Device type", on: { change: () => { state.devType = typeSel.value; chooseSite(state.siteId); } } },
      h("option", { value: "switch", text: "Switches" }), h("option", { value: "gateway", text: "WAN edges (SRX, SSR)" }));
    const deviceSel = h("select", { title: "Device", disabled: true, on: { change: () => chooseDevice(deviceSel.value) } });
    const filterBox = h("input", {
      type: "search", placeholder: "Filter ports by name or neighbour…",
      style: "width:auto;flex:1;min-width:14rem;",
      on: { input: () => { state.filter = filterBox.value.trim().toLowerCase(); drawPorts(); } },
    });
    const upOnlyBox = h("input", { type: "checkbox", on: { change: () => { state.upOnly = upOnlyBox.checked; drawPorts(); } } });
    const portsHost = h("div", { style: "margin-top:.85rem;" });
    const addBtn = h("button", { type: "button", className: "btn btn-p", text: "Add selected to flow", disabled: true, on: { click: addTicked } });
    const pathsBtn = h("button", { type: "button", className: "btn btn-s", text: "Show this WAN edge's paths", disabled: true, title: "List the peer paths and WAN tunnels of the chosen WAN edge, to add one as a hop", on: { click: () => suggestPaths() } });
    const tickAllBtn = h("button", { type: "button", className: "btn btn-s", text: "Select all shown", on: { click: () => { for (const p of shownPorts()) state.ticked.add(p.port_id); drawPorts(); } } });
    const untickBtn = h("button", { type: "button", className: "btn btn-g", text: "Clear selection", on: { click: () => { state.ticked.clear(); drawPorts(); } } });

    const flowHost = h("div");
    const nextHost = h("div", { style: "margin-top:.7rem;" });
    const clearFlowBtn = h("button", { type: "button", className: "btn btn-g", text: "Clear flow", on: { click: () => { state.flow = []; state.cur.clear(); state.base.clear(); state.next = null; flowChanged(); } } });
    const nextBtn = h("button", { type: "button", className: "btn btn-p", text: "Find next hop →", disabled: true, title: "Look up what the last hop connects to: its LLDP neighbour, or the peer paths of a WAN port", on: { click: () => suggestNext() } });
    const saveFlowBtn = h("button", { type: "button", className: "btn btn-s", text: "Save flow", disabled: true, title: "Download the hop list as a file, to load it again later", on: { click: saveFlow } });
    const fileBox = h("input", { type: "file", accept: ".json,application/json", style: "display:none;", on: { change: () => loadFlow() } });
    const loadFlowBtn = h("button", { type: "button", className: "btn btn-s", text: "Load flow", title: "Load a hop list saved earlier", on: { click: () => fileBox.click() } });

    const autoBox = h("input", { type: "checkbox", checked: true, on: { change: () => { state.auto = autoBox.checked; state.failedPolls = 0; state.note = ""; schedule(0); drawStatus(); } } });
    const cliBox = h("input", {
      type: "checkbox", checked: true,
      title: "Read the counters from the CLI of each switch and SRX (show interfaces extensive). Untick to use Mist's port stats only.",
      on: { change: () => { state.useCli = cliBox.checked; cliDown.clear(); state.base = new Map(); state.note = ""; schedule(0); drawStatus(); } },
    });
    const secsBox = h("input", {
      type: "number", min: String(MIN_SECS), max: "3600", step: "1", value: String(DEFAULT_SECS), title: "Seconds between refreshes",
      style: "width:5.5rem;",
      on: { change: () => {
        const n = Math.round(Number(secsBox.value));
        state.secs = isFinite(n) && n >= MIN_SECS ? Math.min(n, 3600) : DEFAULT_SECS;
        secsBox.value = String(state.secs);
        schedule(state.secs * 1000);
        drawStatus();
      } },
    });
    const refreshBtn = h("button", { type: "button", className: "btn btn-p", text: "Refresh now", disabled: true, on: { click: () => refresh() } });
    const baselineBtn = h("button", { type: "button", className: "btn btn-s", text: "Reset baseline", disabled: true, title: "Measure the changes from now on", on: { click: () => { state.base = new Map(state.cur); drawResults(); } } });
    const sleBtn = h("button", { type: "button", className: "btn btn-s", text: "24 h WAN health", disabled: true, title: "Read the last 24 hours of Mist's WAN SLEs for each WAN edge in the flow", on: { click: () => loadSle() } });
    const xlsxBtn = h("button", { type: "button", className: "btn btn-s", text: "Download .xlsx", disabled: true, on: { click: saveXlsx } });
    const csvBtn = h("button", { type: "button", className: "btn btn-s", text: "Download .csv", disabled: true, on: { click: saveCsv } });
    const liveDot = h("span", { style: "display:inline-block;width:8px;height:8px;border-radius:99px;margin-right:.45rem;" });
    const statusText = h("span");
    const statusEl = h("div", { className: "muted", style: "font-size:13px;margin-top:.7rem;" }, liveDot, statusText);
    const resultsHost = h("div", { style: "margin-top:1rem;" });

    const step = (n, text) => [h("span", { className: "accent", text: n + "  " }), text];
    const view = h("div", null,
      h("div", { className: "card", style: PANEL },
        h("div", { style: TITLE }, step(1, "Add hops")),
        h("div", { className: "params" },
          h("label", null, h("span", { text: "Site" }), siteSel),
          h("label", null, h("span", { text: "Device type" }), typeSel),
          h("label", null, h("span", { text: "Device" }), deviceSel)),
        h("div", { className: "actions", style: "margin-top:.85rem;" },
          filterBox, h("label", { className: "check" }, upOnlyBox, "Up only"), tickAllBtn, untickBtn, addBtn, pathsBtn),
        portsHost,
        h("div", { className: "muted", style: HINT, text: "Pick another site or device at any time. Hops already in the flow stay there." })),
      h("div", { className: "card", style: PANEL },
        h("div", { className: "row", style: "margin-bottom:.5rem;" }, h("div", { style: TITLE + "margin:0;" }, step(2, "Flow path, in hop order")),
          h("div", { className: "actions" }, nextBtn, saveFlowBtn, loadFlowBtn, fileBox, clearFlowBtn)),
        flowHost, nextHost),
      h("div", { className: "card", style: PANEL },
        h("div", { style: TITLE }, step(3, "Live statistics")),
        h("div", { className: "actions" },
          h("label", { className: "check" }, autoBox, "Auto-refresh every"),
          secsBox, h("span", { className: "muted", text: "seconds" }),
          h("label", { className: "check", title: cliBox.title }, cliBox, "Live from device CLI"),
          refreshBtn, baselineBtn, sleBtn, xlsxBtn, csvBtn),
        statusEl,
        resultsHost));
    clear(root, view);

    function fillSelect(sel, firstLabel, options, value) {
      clear(sel, h("option", { value: "", text: firstLabel }), options.map((o) => h("option", { value: o.value, text: o.label })));
      sel.value = value || "";
    }

    const siteOf = (id) => state.sites.find((s) => s.id === id) || { id, name: "" };
    const devKey = (f) => f.siteId + "|" + f.mac;
    const warnOnce = (key, message) => { if (!warned.has(key)) { warned.add(key); log(message, "err"); } };

    // ---- 1. picker ------------------------------------------------------
    const typeWord = () => (state.devType === "gateway" ? "WAN edges" : "switches");

    async function chooseSite(siteId) {
      state.siteId = siteId;
      state.mac = "";
      state.devices = [];
      state.ports = [];
      state.ticked.clear();
      const type = state.devType;
      fillSelect(deviceSel, siteId ? "Loading " + typeWord() + "…" : "Choose a site first", [], "");
      deviceSel.disabled = true;
      drawPorts();
      if (!siteId) return;
      try {
        const devices = await ctx.getAll("/sites/" + siteId + "/stats/devices", { type });
        if (state.siteId !== siteId || state.devType !== type) return;        // the user moved on
        state.devices = (devices || [])
          .filter((d) => d && normMac(d.mac))
          .map((d) => {
            const mac = normMac(d.mac);
            if (type === "gateway") { gwStat.set(siteId + "|" + mac, d); health.set(siteId + "|" + mac, deviceHealth(d)); }
            return { mac, name: d.name || d.hostname || ctx.fmtMac(d.mac), model: d.model || "", status: d.status || "", type };
          })
          .sort((a, b) => natural(a.name, b.name));
        fillSelect(deviceSel, state.devices.length ? "Choose a device (" + state.devices.length + ")" : "No " + typeWord() + " at this site",
          state.devices.map((s) => ({ value: s.mac, label: s.name + (s.model ? "  ·  " + s.model : "") + (s.status && s.status !== "connected" ? "  ·  " + s.status : "") })), "");
        deviceSel.disabled = !state.devices.length;
      } catch (e) {
        fillSelect(deviceSel, "Could not load " + typeWord(), [], "");
        log("Device list failed: " + e.message, "err");
        drawPorts("Could not load " + typeWord() + ": " + e.message);
      }
    }

    function loadPorts(siteId, mac, deviceType) {
      return ctx.searchAll("/sites/" + siteId + "/stats/ports/search", { device_type: deviceType === "gateway" ? "gateway" : "switch", mac, limit: 1000 })
        .then((records) => latestPerPort(records, mac));
    }

    async function cachedPorts(siteId, mac, deviceType) {
      const k = siteId + "|" + mac;
      if (!portCache.has(k)) portCache.set(k, await loadPorts(siteId, mac, deviceType));
      return portCache.get(k);
    }

    async function chooseDevice(mac) {
      state.mac = mac;
      state.ports = [];
      state.ticked.clear();
      if (!mac) { drawPorts(); return; }
      const siteId = state.siteId;
      const type = state.devType;
      if (!portCache.has(siteId + "|" + mac)) drawPorts("Loading ports…");
      try {
        const ports = await cachedPorts(siteId, mac, type);
        if (state.siteId !== siteId || state.mac !== mac) return;
        state.ports = ports;
        drawPorts();
      } catch (e) {
        log("Port list failed: " + e.message, "err");
        if (state.siteId === siteId && state.mac === mac) drawPorts("Could not load ports: " + e.message);
      }
    }

    function shownPorts() {
      return state.ports.filter((p) => {
        if (state.upOnly && !p.up) return false;
        if (!state.filter) return true;
        return (p.port_id + " " + neighbourOf(p) + " " + (p.port_usage || "")).toLowerCase().includes(state.filter);
      });
    }

    const pickedDevice = () => state.devices.find((s) => s.mac === state.mac);

    function drawPorts(message) {
      addBtn.disabled = state.ticked.size === 0;
      addBtn.textContent = state.ticked.size ? "Add " + state.ticked.size + " to flow" : "Add selected to flow";
      pathsBtn.disabled = !(state.devType === "gateway" && state.mac);
      if (message || !state.mac) {
        clear(portsHost, h("div", { className: "muted", style: EMPTY, text: message || "Choose a site and a device to list its ports." }));
        return;
      }
      const shown = shownPorts();
      if (!shown.length) {
        clear(portsHost, h("div", { className: "muted", style: EMPTY, text: state.ports.length ? "No ports match the filter." : "Mist has no port statistics for this device." }));
        return;
      }
      const gw = state.devType === "gateway";
      const stat0 = gw ? gwStat.get(state.siteId + "|" + state.mac) : null;
      const inFlow = new Set(state.flow.map((f) => f.key));
      const rows = shown.map((p) => {
        const key = state.siteId + "|" + state.mac + "|" + p.port_id;
        const already = inFlow.has(key);
        const box = h("input", {
          type: "checkbox", style: BOX, checked: state.ticked.has(p.port_id) || already, disabled: already,
          on: { change: () => { if (box.checked) state.ticked.add(p.port_id); else state.ticked.delete(p.port_id); drawPorts(); } },
        });
        const info = gw ? ifInfo(stat0, p.port_id) : null;
        const wan = info ? [info.wanName, info.isp].filter(Boolean).join(" · ") : "";
        const g = gaugesOf(p);
        const quality = ["loss", "latency", "jitter"].filter((k) => num(g[k]) !== null && (g[k] > 0 || p.port_usage === "wan"))
          .map((k) => fmt1(g[k]) + (k === "loss" ? " %" : " ms")).join(" / ");
        return h("tr", { style: already ? "background:" + tint("good", 10) + ";" : "" },
          h("td", { style: CELL + "padding-left:.5rem;" }, box),
          h("td", { style: CELL + "font-weight:600;", text: p.port_id }),
          h("td", { style: CELL, className: linkClass(p.up ? "Up" : "Down"), text: p.up ? "Up" : "Down" }),
          h("td", { style: CELL, text: fmtSpeed(p.speed) }),
          h("td", { style: CELL, className: "muted", text: p.port_usage || "" }),
          gw ? h("td", { style: CELL, text: wan }) : null,
          gw ? h("td", { style: CELL, className: worstGauge({ gauges: g }), text: quality, title: "Loss / latency / jitter, last sample" }) : null,
          h("td", { style: CELL, text: neighbourOf(p) }),
          h("td", { style: CELL }, already ? h("span", { className: "pill good", text: "in flow" }) : null));
      });
      const heads = gw ? ["", "Port", "Link", "Speed", "Usage", "WAN / ISP", "Loss / latency / jitter", "Neighbour", ""] : ["", "Port", "Link", "Speed", "Usage", "Neighbour", ""];
      clear(portsHost, scrollBox("18rem", tableOf(heads, rows)));
    }

    function addItems(items) {
      const have = new Set(state.flow.map((f) => f.key));
      let added = 0;
      for (const item of items) {
        if (have.has(item.key)) continue;
        have.add(item.key);
        state.flow.push(item);
        added += 1;
      }
      return added;
    }

    function addTicked() {
      const site = siteOf(state.siteId);
      const dev = pickedDevice();
      if (!site.id || !dev) return;
      addItems(state.ports.filter((p) => state.ticked.has(p.port_id)).map((p) => portItem(site, dev, p)));
      state.ticked.clear();
      state.next = null;
      drawPorts();
      flowChanged();
    }

    // ---- 2. flow path ---------------------------------------------------
    function flowChanged() {
      state.failedPolls = 0;
      state.note = "";
      drawFlow();
      drawPorts();
      drawResults();
      schedule(0);            // sample the new set straight away
    }

    function move(i, by) {
      const j = i + by;
      if (j < 0 || j >= state.flow.length) return;
      const [item] = state.flow.splice(i, 1);
      state.flow.splice(j, 0, item);
      state.next = null;
      drawFlow();
      drawResults();
    }

    function drawFlow() {
      const any = state.flow.length > 0;
      refreshBtn.disabled = state.busy || !any;
      clearFlowBtn.disabled = !any;
      nextBtn.disabled = !any;
      saveFlowBtn.disabled = !any;
      sleBtn.disabled = !state.flow.some((f) => f.deviceType === "gateway");
      if (!any) {
        clear(flowHost, h("div", { className: "muted", style: EMPTY, text: "No hops yet. Add the ports the flow passes through, from any site, or load a saved flow." }));
        drawNext();
        return;
      }
      const small = "margin-right:.35rem;";
      const off = (flag) => small + (flag ? "opacity:.35;" : "");
      const rows = state.flow.map((f, i) => {
        const now = state.cur.get(f.key);
        const mtu = now && now.s.mtu ? String(now.s.mtu) : "";
        const kind = f.kind === "path" ? (f.pathType === "tunnel" ? "WAN tunnel" : "Peer path") : f.deviceType === "gateway" ? (f.platform === "ssr" ? "SSR port" : "SRX port") : "Switch port";
        return h("tr", null,
          h("td", { style: CELL, className: "accent", text: i + 1 }),
          h("td", { style: CELL, className: "muted", text: kind }),
          h("td", { style: CELL, text: f.siteName }),
          h("td", { style: CELL + "font-weight:600;", text: f.deviceName }),
          h("td", { style: CELL + "font-weight:600;", text: hopLabel(f) }),
          h("td", { style: CELL, text: mtu }),
          h("td", { style: CELL, className: "muted", text: f.kind === "path" ? "" : f.neighbour }),
          h("td", { style: CELL + "text-align:right;padding-right:0;" },
            h("button", { type: "button", className: "chip", text: "↑", title: "Move up", style: off(i === 0), disabled: i === 0, on: { click: () => move(i, -1) } }),
            h("button", { type: "button", className: "chip", text: "↓", title: "Move down", style: off(i === state.flow.length - 1), disabled: i === state.flow.length - 1, on: { click: () => move(i, 1) } }),
            h("button", { type: "button", className: "chip", text: "✕", title: "Remove", style: small, on: { click: () => { state.flow.splice(i, 1); state.next = null; flowChanged(); } } })));
      });
      clear(flowHost, scrollBox("18rem", tableOf(["Hop", "Kind", "Site", "Device", "Port / path", "MTU", "Neighbour", ""], rows)));
      drawNext();
    }

    // ---- next hop -------------------------------------------------------
    function drawNext() {
      const n = state.next;
      if (!n) { clear(nextHost); return; }
      clear(nextHost,
        h("div", { className: "muted", style: "font-size:13px;margin-bottom:.35rem;", text: n.message }),
        (n.options || []).map((o) => h("div", { style: "display:flex;gap:.6rem;align-items:center;padding:2px 0;font-size:13px;" },
          h("button", { type: "button", className: "btn btn-s", text: "Add", on: { click: () => {
            addItems(o.items);
            state.next = null;
            flowChanged();
          } } }),
          h("span", { style: "overflow-wrap:anywhere;min-width:0;" }, o.label, o.note ? h("span", { className: "muted", text: "  " + o.note }) : null))));
    }

    // The org's switches and WAN edges by MAC, read once when first needed.
    function orgDevices() {
      if (!orgIndex) {
        orgIndex = Promise.all(["switch", "gateway"].map((type) => ctx.getAll("/orgs/" + ctx.orgId + "/stats/devices", { type })
          .then((list) => (list || []).map((d) => ({ mac: normMac(d.mac), name: d.name || d.hostname || "", hostname: d.hostname || "", model: d.model || "", siteId: d.site_id || "", type })))))
          .then((lists) => new Map(lists.flat().filter((d) => d.mac && d.siteId).map((d) => [d.mac, d])));
        orgIndex.catch(() => { orgIndex = null; });
      }
      return orgIndex;
    }

    function loadPaths(mac) {
      return ctx.searchAll("/orgs/" + ctx.orgId + "/stats/vpn_peers/search", { mac, limit: 1000 });
    }

    function loadTunnels(mac) {
      return ctx.searchAll("/orgs/" + ctx.orgId + "/stats/tunnels/search", { type: "wan", mac, limit: 1000 });
    }

    const quality = (r) => ["loss", "latency", "jitter"].filter((k) => num(r[k]) !== null).map((k) => fmt1(r[k]) + (k === "loss" ? " % loss" : " ms " + k)).join(", ");

    // The peer paths and tunnels of one WAN edge as things to add. A peer path
    // brings the far WAN edge's port with it, so the flow carries on there.
    async function pathOptions(dev, site, portId) {
      const [paths, tunnels, index] = await Promise.all([
        loadPaths(dev.mac).catch((e) => { log(dev.name + ": peer paths not read (" + e.message + ").", "err"); return []; }),
        loadTunnels(dev.mac).catch(() => []),
        orgDevices().catch(() => new Map()),
      ]);
      const newest = new Map();
      for (const r of paths || []) {
        if (normMac(r.mac) !== dev.mac || !normMac(r.peer_mac)) continue;
        const item = peerPathItem(site, dev, r);
        const seen = newest.get(item.key);
        if (!seen || (num(r.last_seen) || 0) >= (num(seen.r.last_seen) || 0)) newest.set(item.key, { item, r });
      }
      let list = [...newest.values()];
      if (portId && list.some((x) => x.item.portId === portId)) list = list.filter((x) => x.item.portId === portId);
      const options = list.sort((a, b) => natural(hopLabel(a.item), hopLabel(b.item))).map(({ item, r }) => {
        const far = index.get(item.peerMac);
        const farSite = siteOf(item.peerSiteId || (far && far.siteId) || "");
        const farDev = { mac: item.peerMac, name: (far && far.name) || item.peerName, model: (far && far.model) || "", type: "gateway", pathType: r.type };
        const items = [item];
        if (farSite.id && item.peerPortId) items.push(portItem(farSite, farDev, { port_id: item.peerPortId }));
        return { label: "Peer path " + hopLabel(item), note: [r.up ? "up" : "down", quality(r), items.length > 1 ? "adds the path and " + farDev.name + " " + item.peerPortId : ""].filter(Boolean).join(" · "), items };
      });
      const tun = new Map();
      for (const r of tunnels || []) {
        if (normMac(r.mac) !== dev.mac || !r.tunnel_name) continue;
        const item = tunnelItem(site, dev, r);
        tun.set(item.key, { label: hopLabel(item), note: [r.up ? "up" : "down", r.protocol, r.wan_name && "over " + r.wan_name].filter(Boolean).join(" · "), items: [item] });
      }
      return [...options, ...tun.values()];
    }

    async function suggestPaths() {
      const dev = pickedDevice();
      const site = siteOf(state.siteId);
      if (!dev || dev.type !== "gateway") return;
      state.next = { message: "Reading the paths of " + dev.name + "…", options: [] };
      drawNext();
      try {
        const options = await pathOptions(dev, site, "");
        state.next = { message: options.length ? "Peer paths and WAN tunnels of " + dev.name + ":" : "Mist has no peer paths or WAN tunnels for " + dev.name + ".", options };
      } catch (e) {
        state.next = { message: "Could not read the paths: " + e.message, options: [] };
      }
      drawNext();
    }

    async function suggestNext() {
      const last = state.flow[state.flow.length - 1];
      if (!last) return;
      state.next = { message: "Looking up what hop " + state.flow.length + " connects to…", options: [] };
      drawNext();
      const options = [];
      const notes = [];
      try {
        if (last.kind === "path") {
          if (last.pathType === "tunnel") notes.push("A WAN tunnel ends outside Mist, so there is no next hop to look up.");
          else {
            const index = await orgDevices();
            const far = index.get(last.peerMac);
            const farSite = siteOf(last.peerSiteId || (far && far.siteId) || "");
            if (farSite.id && last.peerPortId) {
              const farDev = { mac: last.peerMac, name: (far && far.name) || last.peerName, model: (far && far.model) || "", type: "gateway", pathType: last.vpnType };
              options.push({ label: "Far end: " + farDev.name + " " + last.peerPortId, note: farSite.name, items: [portItem(farSite, farDev, { port_id: last.peerPortId })] });
            } else notes.push("Mist did not say which site or port the far end of this path is on.");
          }
        } else {
          const ports = await cachedPorts(last.siteId, last.mac, last.deviceType);
          const port = ports.find((p) => p.port_id === last.portId);
          if (port && (port.neighbor_mac || port.neighbor_system_name)) {
            const index = await orgDevices();
            const nb = findNeighbourDevice(port, index.values());
            if (!nb) notes.push("The LLDP neighbour (" + neighbourOf(port) + ") is not a switch or WAN edge of this organization.");
            else {
              const nbPorts = await cachedPorts(nb.siteId, nb.mac, nb.type);
              const facing = facingPorts(nbPorts, last, port);
              const nbSite = siteOf(nb.siteId);
              for (const p of facing) options.push({ label: "LLDP neighbour: " + nb.name + " " + p.port_id, note: [nbSite.name, p.up ? "up" : "down"].filter(Boolean).join(" · "), items: [portItem(nbSite, nb, p)] });
              if (!facing.length) notes.push(nb.name + " is the LLDP neighbour, but Mist shows no port on it facing " + last.deviceName + ". Pick the port in step 1.");
            }
          } else if (last.deviceType !== "gateway") notes.push("Mist has no LLDP neighbour for " + last.deviceName + " " + last.portId + ".");
          if (last.deviceType === "gateway") {
            const dev = { mac: last.mac, name: last.deviceName, model: last.model, type: "gateway" };
            options.push(...await pathOptions(dev, siteOf(last.siteId), last.portId));
          }
        }
        const have = new Set(state.flow.map((f) => f.key));
        const fresh = options.filter((o) => o.items.some((it) => !have.has(it.key)));
        state.next = {
          message: [fresh.length ? "Next hop after " + last.deviceName + " " + hopLabel(last) + ":" : "Nothing new found after " + last.deviceName + " " + hopLabel(last) + ".", ...notes].join("  "),
          options: fresh,
        };
      } catch (e) {
        state.next = { message: "Could not look up the next hop: " + e.message, options: [] };
        log("Next hop lookup failed: " + e.message, "err");
      }
      drawNext();
    }

    // ---- save / load ----------------------------------------------------
    function saveFlow() {
      try {
        const keep = ["kind", "pathType", "siteId", "siteName", "mac", "deviceName", "deviceType", "model", "portId", "neighbour", "neighbourMac",
          "peerMac", "peerPortId", "peerName", "peerSiteId", "vpnType", "tunnelName", "peerIp", "node"];
        const hops = state.flow.map((f) => Object.fromEntries(keep.filter((k) => f[k] !== undefined && f[k] !== "").map((k) => [k, f[k]])));
        const text = JSON.stringify({ kind: FLOW_FILE_KIND, version: 1, org: ctx.orgId, hops }, null, 2);
        const fileName = ctx.stampedName("mist_flow_path", ctx.orgName, "json");
        ctx.download(new Blob([text], { type: "application/json" }), fileName);
        log("Saved " + fileName, "ok");
      } catch (e) {
        log("Could not save the flow: " + e.message, "err");
      }
    }

    async function loadFlow() {
      const file = fileBox.files && fileBox.files[0];
      fileBox.value = "";
      if (!file) return;
      try {
        if (file.size > 1024 * 1024) throw new Error("The file is too large to be a saved flow.");
        const hops = cleanFlow(JSON.parse(await file.text()), ctx.orgId);
        for (const f of hops) if (!f.siteName) f.siteName = siteOf(f.siteId).name;
        state.flow = hops;
        state.cur.clear();
        state.base.clear();
        state.next = null;
        log("Loaded " + plural(hops.length, "hop") + " from " + file.name + ".", "ok");
        flowChanged();
      } catch (e) {
        log("Could not load the flow: " + e.message, "err");
        state.note = "Could not load the flow: " + e.message;
        drawStatus();
      }
    }

    // ---- 3. live statistics ---------------------------------------------
    function cliUsable(g) {
      if (!state.useCli || g.platform !== "junos") return false;
      const down = cliDown.get(g.key);
      return !down || (!down.refused && Date.now() >= down.until);
    }

    const alive = () => view.isConnected;
    const visible = () => view.getClientRects().length > 0;

    function schedule(delayMs) {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (!state.auto || !state.flow.length || !alive()) return;
      timer = setTimeout(tick, Math.max(0, delayMs));
    }

    async function tick() {
      timer = null;
      if (!alive()) return;                        // stop for good
      if (visible() && !state.busy) await collect(false);
      schedule(state.secs * 1000);
    }

    async function refresh() {
      state.failedPolls = 0;
      state.note = "";
      await collect(true);
      schedule(state.secs * 1000);
    }

    // One device's ports, from its CLI, one command per port.
    async function readCli(g, fresh) {
      for (const item of g.ports) {
        const json = junosJson(await ctx.junosShow(g.siteId, g.mac, "show interfaces extensive " + item.portId));
        const list = interfaceCounters(json);
        const iface = list.find((r) => r.name === item.portId) || list[0];
        if (iface) fresh.set(item.key, { t: Date.now(), s: cliSample(iface, g.type === "gateway" ? flowErrors(json) : null) });
      }
    }

    // One device's ports, from Mist's port stats.
    async function readRest(g, fresh) {
      const ports = await loadPorts(g.siteId, g.mac, g.type);
      portCache.set(g.key, ports);
      const t = Date.now();
      const byId = new Map(ports.map((p) => [p.port_id, p]));
      for (const item of g.ports) {
        const p = byId.get(item.portId);
        if (p) {
          fresh.set(item.key, { t, s: restSample(p) });
          item.neighbour = neighbourOf(p) || item.neighbour;
          item.neighbourMac = normMac(p.neighbor_mac) || item.neighbourMac;
        }
      }
    }

    // A WAN edge's own health and interface details.
    async function readHealth(g) {
      const st = await ctx.mistGet("/sites/" + g.siteId + "/stats/devices/" + deviceIdFor(g.mac));
      if (st && typeof st === "object") { gwStat.set(g.key, st); health.set(g.key, deviceHealth(st)); }
    }

    async function readPaths(g, fresh) {
      const t = Date.now();
      const want = (type) => g.paths.filter((p) => p.pathType === type);
      if (want("peer").length) {
        const records = await loadPaths(g.mac);
        for (const item of want("peer")) { const r = pickPath(item, records); if (r) fresh.set(item.key, { t, s: pathSample(item, r) }); }
      }
      if (want("tunnel").length) {
        const records = await loadTunnels(g.mac);
        for (const item of want("tunnel")) { const r = pickPath(item, records); if (r) fresh.set(item.key, { t, s: pathSample(item, r) }); }
      }
    }

    function groupsOf(flow) {
      const groups = new Map();           // one job per device
      for (const f of flow) {
        const k = devKey(f);
        if (!groups.has(k)) groups.set(k, { key: k, siteId: f.siteId, mac: f.mac, label: f.deviceName, type: f.deviceType, platform: f.platform, ports: [], paths: [] });
        groups.get(k)[f.kind === "path" ? "paths" : "ports"].push(f);
      }
      return [...groups.values()];
    }

    async function collect(force) {
      if (state.busy || !state.flow.length) return;
      state.busy = true;
      refreshBtn.disabled = true;
      drawStatus();

      const list = groupsOf(state.flow);
      const errors = [];
      const fresh = new Map();
      try {
        await ctx.pool(ctx.POOL_LIMIT || 6, list.map((g) => async () => {
          const now = Date.now();
          const due = force || !restAt.has(g.key) || now - restAt.get(g.key) >= REST_MS;
          const missing = (items) => items.some((it) => !state.cur.has(it.key));
          let failed = false;
          let fromRest = g.ports.length > 0;
          if (g.ports.length && cliUsable(g)) {
            try {
              await readCli(g, fresh);
              fromRest = false;
              if (cliDown.has(g.key)) { cliDown.delete(g.key); log(g.label + ": reading the device CLI again.", "ok"); }
            } catch (e) {
              const refused = isRefusal(e.message);
              cliDown.set(g.key, { refused, until: Date.now() + CLI_RETRY_MS, reason: e.message });
              log(g.label + ": device CLI not available (" + e.message + "). Using Mist's port stats"
                + (refused ? "." : " and trying the CLI again in a minute."), "err");
            }
          }
          if (fromRest && (due || g.ports.some((it) => !fresh.has(it.key) && (!state.cur.has(it.key) || state.cur.get(it.key).s.src !== "rest")))) {
            try { await readRest(g, fresh); } catch (e) { failed = true; errors.push(g.label + ": " + e.message); }
          }
          if (g.type === "gateway" && (due || !health.has(g.key))) {
            try { await readHealth(g); } catch (e) { warnOnce("health|" + g.key, g.label + ": WAN edge health not read (" + e.message + ")."); }
          }
          if (g.paths.length && (due || missing(g.paths))) {
            try { await readPaths(g, fresh); } catch (e) { if (!g.ports.length) { failed = true; errors.push(g.label + ": " + e.message); } else warnOnce("paths|" + g.key, g.label + ": paths not read (" + e.message + ")."); }
          }
          if (due && !failed) restAt.set(g.key, now);
        }));
      } catch (e) {
        errors.push(e.message);
      } finally {
        state.busy = false;
      }
      if (!alive()) return;

      const failedAll = errors.length >= list.length;
      if (failedAll) {
        state.failedPolls += 1;
        if (state.failedPolls === 1) for (const m of errors) log(m, "err");
        if (state.failedPolls >= MAX_FAILED_POLLS && state.auto) {
          state.auto = false;
          autoBox.checked = false;
          state.note = "Auto-refresh stopped after " + MAX_FAILED_POLLS + " failed attempts: " + errors[0];
          log(state.note, "err");
        } else {
          state.note = "Last refresh failed: " + errors[0];
        }
      } else {
        if (errors.length && state.failedPolls === 0) for (const m of errors) log(m, "err");
        state.failedPolls = 0;
        state.note = errors.length ? plural(errors.length, "device") + " did not answer (see the log)" : "";
        // Hops that failed this round keep their last good sample.
        const keys = new Set(state.flow.map((f) => f.key));
        for (const k of [...state.cur.keys()]) if (!keys.has(k)) state.cur.delete(k);
        for (const k of [...state.base.keys()]) if (!keys.has(k)) state.base.delete(k);
        for (const [k, v] of fresh) {
          if (!keys.has(k)) continue;
          state.cur.set(k, v);
          // A new hop, or one whose source changed, starts a new baseline.
          const b = state.base.get(k);
          if (!b || b.s.src !== v.s.src) state.base.set(k, v);
        }
        state.polls += 1;
        state.lastUpdate = Date.now();
        if (state.polls === 1) log("Live statistics started for " + plural(state.flow.length, "hop") + ".", "ok");
      }
      drawFlow();
      drawResults();
    }

    // The last 24 hours of Mist's WAN SLEs for each WAN edge in the flow.
    async function loadSle() {
      const gateways = groupsOf(state.flow).filter((g) => g.type === "gateway");
      if (!gateways.length) return;
      sleBtn.disabled = true;
      const pretty = (m) => m.replace(/[-_]/g, " ").replace(/^./, (ch) => ch.toUpperCase());
      for (const g of gateways) {
        const base = "/sites/" + g.siteId + "/sle/gateway/" + deviceIdFor(g.mac);
        try {
          const listed = await ctx.mistGet(base + "/metrics");
          const names = [...new Set([...((listed && listed.enabled) || []), ...((listed && listed.supported) || [])])]
            .filter((m) => /wan|gateway|application/i.test(m)).slice(0, 4);
          if (!names.length) throw new Error("Mist lists no WAN SLEs for this device");
          const metrics = [];
          for (const m of names) {
            const resp = await ctx.mistGet(base + "/metric/" + encodeURIComponent(m) + "/summary-trend", { duration: "1d" });
            metrics.push({ label: pretty(m), ...sleScore(resp) });
          }
          sle.set(g.key, { metrics });
        } catch (e) {
          sle.set(g.key, { error: "not available (" + e.message + ")" });
          log(g.label + ": 24 h WAN health not read (" + e.message + ").", "err");
        }
      }
      sleBtn.disabled = false;
      drawResults();
    }

    function currentRows() {
      return buildRows(state.flow, state.cur, state.base);
    }

    function drawStatus() {
      const live = state.auto && state.flow.length > 0;
      liveDot.style.background = state.note && !live ? "var(--crit)" : live ? "var(--good)" : "var(--subtle)";
      const parts = [];
      if (!state.flow.length) parts.push("Waiting for hops");
      else if (live) parts.push("Live, every " + state.secs + " s");
      else parts.push("Paused");
      const devices = groupsOf(state.flow).filter((g) => g.ports.length);
      const viaCli = devices.filter(cliUsable).length;
      if (devices.length) {
        parts.push(viaCli === devices.length ? "all devices read over the CLI"
          : viaCli === 0 ? "Mist stats only, refreshed once a minute"
            : viaCli + " of " + devices.length + " devices over the CLI, the rest from Mist stats once a minute");
      }
      if (state.busy) parts.push("refreshing…");
      else if (state.lastUpdate) parts.push("updated " + clock(state.lastUpdate));
      if (state.note) parts.push(state.note);
      statusText.textContent = parts.join("  ·  ");
    }

    function verdictBox(findings, rows) {
      const worst = findings[0];
      const colour = !worst ? "good" : worst.level === "crit" ? "crit" : worst.level === "warn" ? "warn" : "accent";
      const measured = rows.some((r) => r.since);
      const head = !worst ? "No problems seen on " + plural(rows.length, "hop") + (measured ? " since the baseline." : " so far. Counters are compared from the next refresh on.")
        : worst.level === "info" ? "No errors seen. " + plural(findings.length, "note") + "."
          : "Look at hop " + worst.hop + " first. " + plural(findings.filter((f) => f.level !== "info").length, "finding") + " along the path.";
      return h("div", { style: "border:1px solid var(--border);border-left:5px solid var(--" + colour + ");border-radius:6px;padding:10px 12px;margin-bottom:1rem;background:" + tint(colour, 6) + ";" },
        h("div", { style: "font-weight:600;font-size:14px;" + (findings.length ? "margin-bottom:.35rem;" : ""), className: colour === "accent" ? "" : colour, text: head }),
        findings.slice(0, 12).map((f) => h("div", { style: "display:flex;gap:.6rem;font-size:13px;padding:1px 0;" },
          h("span", { className: f.level === "info" ? "muted" : f.level, style: "white-space:nowrap;font-weight:600;min-width:4.2rem;", text: "Hop " + f.hop }),
          h("span", { style: "overflow-wrap:anywhere;min-width:0;", text: f.text }))),
        findings.length > 12 ? h("div", { className: "muted", style: "font-size:12px;", text: "…and " + (findings.length - 12) + " more, in the .xlsx." }) : null);
    }

    function drawResults() {
      const has = state.cur.size > 0 && state.flow.length > 0;
      xlsxBtn.disabled = !has;
      csvBtn.disabled = !has;
      baselineBtn.disabled = !has;
      drawStatus();
      if (!has) {
        clear(resultsHost, h("div", { className: "muted", style: EMPTY, text: state.flow.length ? "Collecting the first sample…" : "Add hops to the flow and their statistics appear here, refreshed automatically." }));
        return;
      }
      const data = currentRows();
      const newErrors = data.reduce((n, r) => n + r.newErrors, 0);
      const mtu = smallestMtu(data);
      const findings = flowVerdict(data, health);
      const tiles = [
        tile(data.length, "Hops in flow", "#1f4e78"),
        tile(data.filter((r) => r.s && r.s.up).length, "Up", "var(--good)"),
        tile(data.filter((r) => r.s && !r.s.up).length, "Down", "var(--crit)"),
        tile(data.filter((r) => r.newErrors > 0).length, "Hops with new errors", "var(--crit)"),
        tile(fmtInt(newErrors), "New errors and drops since baseline", "var(--crit)"),
        tile(data.filter((r) => r.state === "degraded").length, "Hops with high loss, latency or jitter", "var(--warn)"),
        tile(mtu ? String(mtu.mtu) : "—", mtu ? (mtu.uniform ? "MTU, same on every hop" : "Smallest MTU, hop " + mtu.hops.join(", ")) : "MTU (CLI and paths only)", mtu && !mtu.uniform ? "var(--warn)" : "var(--subtle)"),
        tile(data.filter((r) => !r.s).length, "No data", "var(--subtle)"),
      ];
      const shownHealth = new Set();
      const tilesOut = data.map((r) => {
        if (r.item.kind === "path") return pathTile(r, ctx, openRaw);
        let extra = null;
        if (r.item.deviceType === "gateway") {
          const k = devKey(r.item);
          const first = !shownHealth.has(k);
          shownHealth.add(k);
          // The device's own health once per WAN edge; the interface line on every port.
          extra = healthStrip(first ? health.get(k) : null, ifInfo(gwStat.get(k), r.item.portId), first ? sle.get(k) : null);
        }
        return portTile(r, ctx, openRaw, extra);
      });
      clear(resultsHost,
        verdictBox(findings, data),
        h("div", { style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:1rem;" }, tiles),
        h("div", { style: "display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,23rem),1fr));gap:10px;" }, tilesOut),
        h("div", { className: "muted", style: HINT, text:
          "Port tiles follow \"show interfaces extensive\". Switches and SRX are read from the device CLI; SSR ports, peer paths, tunnels and WAN edge health come from Mist's stats, "
          + "which refresh about once a minute and carry only total errors. Green +numbers are traffic since the baseline; red means an error or drop counter grew. "
          + "A dash means the counter is not available from that source. Loss is in percent, latency and jitter in milliseconds, as Mist last sampled them." }));
    }

    // ---- export ---------------------------------------------------------
    function exportData() {
      const rows = currentRows();
      const columns = [
        { header: "Hop", key: "hop" }, { header: "Kind", key: "kind" }, { header: "Site", key: "site" }, { header: "Device", key: "device" }, { header: "Port / path", key: "port" },
        { header: "Source", key: "src" }, { header: "State", key: "link" }, { header: "Speed", key: "speed" }, { header: "Duplex", key: "duplex" },
        { header: "MTU", key: "mtu" }, { header: "Rx bps", key: "rx_bps" }, { header: "Tx bps", key: "tx_bps" },
        { header: "Loss %", key: "loss" }, { header: "Latency ms", key: "latency" }, { header: "Jitter ms", key: "jitter" }, { header: "MOS", key: "mos" },
        { header: "Baseline", key: "since" }, { header: "Sampled", key: "sampled" },
      ];
      for (const k of ALL_COUNTERS) {
        columns.push({ header: k.label + " (" + k.key + ")", key: k.key });
        columns.push({ header: "Δ " + k.label, key: "d_" + k.key });
      }
      const blank = (v) => (v === null || v === undefined ? "" : v);
      const flowRows = rows.map((r) => {
        const s = r.s;
        const g = (s && s.gauges) || {};
        const out = {
          hop: r.hop, site: r.item.siteName, device: r.item.deviceName, port: hopLabel(r.item),
          kind: r.item.kind === "path" ? (r.item.pathType === "tunnel" ? "WAN tunnel" : "Peer path") : r.item.deviceType === "gateway" ? "WAN edge port" : "Switch port",
          src: s ? (s.src === "cli" ? "Device CLI" : "Mist stats") : "",
          link: s ? (s.up ? "Up" : "Down") : "No data", speed: s ? s.speed : "", duplex: s ? s.duplex : "",
          mtu: blank(s && s.mtu), rx_bps: blank(s && s.rxBps), tx_bps: blank(s && s.txBps),
          loss: blank(g.loss), latency: blank(g.latency), jitter: blank(g.jitter), mos: blank(g.mos),
          since: r.since ? ctx.epochToUtc(r.since) : "", sampled: r.t ? ctx.epochToUtc(r.t) : "",
        };
        for (const k of ALL_COUNTERS) {
          out[k.key] = blank(r.vals[k.key].v);
          out["d_" + k.key] = blank(r.vals[k.key].d);
        }
        if (r.state === "errors" || r.state === "nodata" || r.state === "down") out.__style = "red";
        else if (r.state === "degraded") out.__style = "yellow";
        return out;
      });
      return { columns, flowRows, rows };
    }

    function rawSheet(rows) {
      const recs = rows.map((r) => rawRecord(r.s));
      const keys = new Set();
      for (const rec of recs) for (const k of Object.keys(rec)) keys.add(k);
      const fields = [...keys].sort();
      const columns = [{ header: "Hop", key: "__hop" }, { header: "Site", key: "__site" }, { header: "Device", key: "__device" }, { header: "Port / path", key: "__port" },
        ...fields.map((k) => ({ header: k, key: k }))];
      const out = rows.map((r, i) => ({ __hop: r.hop, __site: r.item.siteName, __device: r.item.deviceName, __port: hopLabel(r.item), ...recs[i] }));
      return ctx.xlsx.sheet("All fields", columns, out, { tabColor: "7F7F7F" });
    }

    function healthSheet() {
      const rows = [];
      for (const g of groupsOf(state.flow).filter((x) => x.type === "gateway")) {
        const hl = health.get(g.key);
        if (!hl) continue;
        const s = sle.get(g.key);
        rows.push({
          device: g.label, site: siteOf(g.siteId).name, model: hl.model, version: hl.version, status: hl.status,
          cpu: hl.cpu === null ? "" : Math.round(hl.cpu * 10) / 10, memory: hl.memory === null ? "" : hl.memory,
          tables: hl.tables.map((t) => t.label + " " + t.count + "/" + t.limit).join("; "),
          ha: hl.ha ? [hl.ha.status, hl.ha.mode, hl.ha.reason].filter(Boolean).join(" · ") : "", config: hl.config,
          uptime: fmtUptime(hl.uptime), ext_ip: hl.extIp,
          sle: s && s.metrics ? s.metrics.map((m) => m.label + " " + (m.score === null ? "n/a" : (Math.round(m.score * 10) / 10) + "%")).join("; ") : "",
          __style: (num(hl.cpu) !== null && hl.cpu >= LIMITS.cpu[0]) || hl.tables.some((t) => num(t.pct) !== null && t.pct >= LIMITS.table[0]) ? "yellow" : undefined,
        });
      }
      const columns = [{ header: "WAN edge", key: "device" }, { header: "Site", key: "site" }, { header: "Model", key: "model" }, { header: "Version", key: "version" },
        { header: "Status", key: "status" }, { header: "CPU %", key: "cpu" }, { header: "Memory %", key: "memory" }, { header: "Tables (used/limit)", key: "tables" },
        { header: "HA", key: "ha" }, { header: "Config", key: "config" }, { header: "Uptime", key: "uptime" }, { header: "External IP", key: "ext_ip" }, { header: "WAN SLE, last 24 h", key: "sle" }];
      return rows.length ? ctx.xlsx.sheet("WAN edge health", columns, rows, { tabColor: "548235" }) : null;
    }

    async function saveXlsx() {
      try {
        const { columns, flowRows, rows } = exportData();
        const findings = flowVerdict(rows, health);
        const sheets = [
          ctx.xlsx.sheet("Flow", columns, flowRows, { tabColor: "1F4E78" }),
          ctx.xlsx.sheet("Verdict", [{ header: "Level", key: "level" }, { header: "Hop", key: "hop" }, { header: "Finding", key: "text" }],
            findings.length ? findings.map((f) => ({ ...f, __style: f.level === "crit" ? "red" : f.level === "warn" ? "yellow" : undefined }))
              : [{ level: "ok", hop: "", text: "No problems seen along the path." }], { tabColor: "C00000" }),
          healthSheet(),
          rawSheet(rows),
          ctx.xlsx.sheet("Info", [{ header: "Field" }, { header: "Value" }], [
            ["Org", ctx.orgName || ""],
            ["Hops in flow", state.flow.length],
            ["Sites", [...new Set(state.flow.map((f) => f.siteName))].join(", ")],
            ["Last refresh", state.lastUpdate ? ctx.epochToUtc(state.lastUpdate) : ""],
            ["Refreshes", state.polls],
            ["Note", "Port counters come from \"show interfaces extensive\" on switches and SRX (Source: Device CLI), or from Mist's port stats (Source: Mist stats, total errors only) for SSR and when the CLI was not available. Peer paths, WAN tunnels, loss, latency, jitter and WAN edge health come from Mist's stats. Δ columns are the change since the Baseline time."],
          ], { autofilter: false, freeze: null }),
        ].filter(Boolean);
        const blob = await toBlob(ctx.xlsx.workbook(sheets));
        const fileName = ctx.stampedName("mist_flow_path", ctx.orgName, "xlsx");
        ctx.download(blob, fileName);
        log("Saved " + fileName, "ok");
      } catch (e) {
        log("Could not build the .xlsx: " + e.message, "err");
        state.note = "Could not build the .xlsx (" + e.message + "). Use Download .csv instead.";
        drawStatus();
      }
    }

    function saveCsv() {
      try {
        const { columns, flowRows } = exportData();
        const text = ctx.toCsv(columns.map((col) => col.header), flowRows.map((r) => columns.map((col) => r[col.key])));
        const fileName = ctx.stampedName("mist_flow_path", ctx.orgName, "csv");
        ctx.download(new Blob([text], { type: "text/csv;charset=utf-8" }), fileName);
        log("Saved " + fileName, "ok");
      } catch (e) {
        log("Could not save the .csv: " + e.message, "err");
        state.note = "Could not save the .csv: " + e.message;
        drawStatus();
      }
    }

    // ---- start ----------------------------------------------------------
    fillSelect(siteSel, "Loading sites…", [], "");
    fillSelect(deviceSel, "Choose a site first", [], "");
    drawPorts();
    drawFlow();
    drawResults();
    if (ctx.access && ctx.access.level && !["admin", "write", "unknown"].includes(ctx.access.level)) {
      log("Your token is " + (ctx.access.label || ctx.access.level) + ". Mist only opens device CLI sessions for admin-level tokens, so this tool will likely use Mist's port stats (total errors only, about once a minute).", "info");
    }
    try {
      state.sites = await ctx.listSites();
      for (const f of state.flow) if (!f.siteName) f.siteName = siteOf(f.siteId).name;
      fillSelect(siteSel, "Choose a site (" + state.sites.length + ")", state.sites.map((s) => ({ value: s.id, label: s.name })), "");
    } catch (e) {
      fillSelect(siteSel, "Could not load sites", [], "");
      log("Site list failed: " + e.message, "err");
      drawPorts("Could not load sites: " + e.message);
    }
  },
};
