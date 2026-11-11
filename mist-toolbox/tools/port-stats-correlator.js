// Port Stats Correlator - a Mist Provision Box tool (read-only).
//
// Pick ports on switches at any site, put them in hop order, and watch their
// interface counters side by side to find the hop where a flow loses traffic
// or picks up errors: drops, CRC, FIFO, MTU, framing, runts, queue drops…
//
// Live data comes from the switch itself. ctx.junosShow runs
// `show interfaces extensive <port>` over Mist's remote shell (one CLI session
// per switch, opened by the toolbox), so the counters are the CLI's own,
// refreshed every few seconds. Mist's REST port stats are the fallback for a
// switch whose CLI cannot be reached (the token is not admin-level, the switch
// is offline…); they arrive about once a minute and carry only total errors.
//
// The tool draws its own view (mount) because the standard form cannot pick
// several switches and ports across several sites.

import { interfaceCounters } from "../lib/junos-shell.js";

// Styling uses the toolbox's own classes (card, btn, chip, ap-table, muted…)
// and colour variables, so the view matches the built-in tools.
const CELL = "white-space:nowrap;padding-right:1rem;";
const PANEL = "margin-top:1rem;";
const TITLE = "font-weight:600;font-size:1.02rem;margin:0 0 .85rem 0;";
const HINT = "font-size:12px;margin-top:.6rem;";
const EMPTY = "font-size:13px;font-style:italic;padding:.4rem 0;";
const BOX = "width:auto;min-height:auto;";
const CAPS = "font-size:11px;text-transform:uppercase;letter-spacing:.04em;";
const CLIP = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;";
const tint = (name, pct) => "color-mix(in oklab, var(--" + name + ") " + pct + "%, transparent)";
const linkClass = (v) => (v === "Up" ? "good" : v === "Down" ? "crit" : "warn");

const DEFAULT_SECS = 5;
const MIN_SECS = 2;
// Mist allows 5,000 API calls an hour per token. A switch read from the REST
// stats costs one call per refresh, so the interval is stretched when many
// switches are on REST, to stay at or under about 3,000 calls an hour. Switches
// read over the CLI cost no API calls after their session opens.
const SECS_PER_REST_SWITCH = 1.2;
const MAX_FAILED_POLLS = 3;
// After the CLI fails on a switch (other than a refusal), try it again this
// much later; the REST stats fill in meanwhile.
const CLI_RETRY_MS = 60 * 1000;

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
const clock = (ms) => new Date(ms).toLocaleTimeString();

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

const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });

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

// ---- counters -----------------------------------------------------------
// Laid out like "show interfaces extensive". Keys are the flat names
// lib/junos-shell.js interfaceCounters() gives ("in.input-errors"…). The REST
// fallback fills only the few it has (see REST_FIELDS).
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

// What the REST port stats can stand in for.
const REST_FIELDS = {
  "in.input-errors": "rx_errors",
  "out.output-errors": "tx_errors",
  "traffic.input-bytes": "rx_bytes",
  "traffic.output-bytes": "tx_bytes",
  "traffic.input-packets": "rx_pkts",
  "traffic.output-packets": "tx_pkts",
};

/**
 * One sample of one port, from either source, in the same shape:
 * { src: "cli"|"rest", up, speed, duplex, mtu, rxBps, txBps, counters, raw, at }
 */
export function cliSample(iface) {
  const ts = iface.counters || {};
  return {
    src: "cli",
    up: String(iface.operStatus).toLowerCase() === "up",
    speed: String(iface.speed || "").replace(/mbps$/i, "M").replace(/gbps$/i, "G"),
    duplex: String(iface.linkMode || "").replace(/-duplex$/i, " duplex").toLowerCase(),
    mtu: num(iface.mtu),
    rxBps: num(ts["traffic.input-bps"]),
    txBps: num(ts["traffic.output-bps"]),
    counters: { ...ts },
    raw: iface,
    at: null,
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
    counters,
    raw: p,
    at: num(p.timestamp),
  };
}

// Movement of one counter since the baseline. A counter that went backwards
// was cleared on the switch in between, so it is reported as "reset".
export function diff(now, before) {
  if (num(now) === null || num(before) === null) return null;
  return now < before ? "reset" : now - before;
}

const showDelta = (d) => (d === "reset" ? "reset" : num(d) === null || d === 0 ? "" : "+" + fmtInt(d));

/**
 * The rows the view and the exports draw from. `cur` and `base` map a flow
 * key to { t, s } (time, sample). Deltas are only worked out between samples
 * from the same source: CLI and REST counters do not line up.
 */
export function buildRows(flow, cur, base) {
  return flow.map((item, i) => {
    const now = cur.get(item.key);
    const b = base.get(item.key);
    const s = now ? now.s : null;
    const row = { hop: i + 1, item, s, t: now ? now.t : null, vals: {}, since: null, newErrors: 0, state: "ok" };
    const compare = now && b && b.t !== now.t && b.s.src === now.s.src;
    if (compare) row.since = b.t;
    for (const k of ALL_COUNTERS) {
      const v = s ? num(s.counters[k.key]) : null;
      const d = compare ? diff(v, num(b.s.counters[k.key])) : null;
      row.vals[k.key] = { v, d };
      if (k.isError && num(d) !== null && d > 0) row.newErrors += d;
    }
    if (!s) row.state = "nodata";
    else if (row.newErrors > 0) row.state = "errors";
    else if (!s.up) row.state = "down";
    return row;
  });
}

/** The smallest MTU along the flow, and the hops that have it. */
export function smallestMtu(rows) {
  const known = rows.filter((r) => r.s && num(r.s.mtu) !== null);
  if (!known.length) return null;
  const mtu = Math.min(...known.map((r) => r.s.mtu));
  const largest = Math.max(...known.map((r) => r.s.mtu));
  return { mtu, hops: known.filter((r) => r.s.mtu === mtu).map((r) => r.hop), uniform: mtu === largest };
}

/** True when a CLI failure means "never on this switch with this token". */
export const isRefusal = (message) => /\b403\b|admin-level/.test(String(message));

const STATE_COLOUR = { ok: "var(--good)", errors: "var(--crit)", down: "var(--warn)", nodata: "var(--subtle)" };

function scrollBox(maxHeight, table) {
  return h("div", { style: "overflow:auto;max-height:" + maxHeight + ";" }, table);
}

function tableOf(headers, bodyRows) {
  return h("table", { className: "ap-table" },
    h("thead", null, h("tr", null, headers.map((t) => h("th", { style: CELL, text: t })))),
    h("tbody", null, bodyRows));
}

// A count tile with a coloured top edge, as on the built-in dashboards.
function tile(value, label, colour) {
  return h("div", { style: "border:1px solid var(--border);border-top:4px solid " + colour + ";border-radius:6px;padding:8px 10px;" },
    h("b", { style: "display:block;font-size:22px;", text: value }),
    h("span", { className: "muted", style: "font-size:12px;", text: label }));
}

// One "label ........ value  +delta" line inside a port tile.
function counterLine(k, cell, src) {
  const missing = num(cell.v) === null;
  const grew = num(cell.d) !== null && cell.d > 0;
  const hot = k.isError && grew;
  const why = src === "rest" ? "Only the switch CLI reports this counter" : "The switch does not report this counter";
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

// The tile for one hop: header, rates, then Input / Output columns.
function portTile(row, ctx, openRaw) {
  const s = row.s;
  const link = s ? (s.up ? "Up" : "Down") : "No data";
  const meta = s ? [s.speed, s.duplex, s.mtu ? "MTU " + s.mtu : ""].filter(Boolean).join(" · ") : "";
  const bg = row.state === "errors" ? "background:" + tint("crit", 7) + ";" : "";
  const cols = "display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 1.1rem;";
  const fresh = !s ? "" : s.src === "cli" ? "Read from the switch CLI at " + clock(row.t)
    : "Mist stats" + (num(s.at) !== null ? " from " + ctx.fmtTime(s.at) : "") + " (switch CLI not available)";
  const half = (list) => Math.ceil(list.length / 2);
  return h("div", { style: "border:1px solid var(--border);border-left:5px solid " + STATE_COLOUR[row.state] + ";border-radius:6px;padding:10px 12px;min-width:0;" + bg },
    h("div", { style: "display:flex;justify-content:space-between;gap:.6rem;align-items:baseline;" },
      h("div", { style: CLIP + "font-weight:600;font-size:14px;" },
        h("span", { className: "accent", text: row.hop + "  " }), row.item.switchName + "  ", h("span", { text: row.item.portId })),
      h("span", { style: "white-space:nowrap;font-size:12px;font-weight:600;" },
        h("span", { className: linkClass(link), text: link }), meta ? h("span", { className: "muted", style: "font-weight:400;", text: "  " + meta }) : null)),
    h("div", { className: "muted", style: CLIP + "font-size:12px;margin-bottom:.5rem;", text: [row.item.siteName, row.item.neighbour].filter(Boolean).join("  →  ") }),
    !s ? h("div", { className: "muted", style: EMPTY, text: "No statistics for this port yet." }) : [
      h("div", { style: cols + "font-size:13px;margin-bottom:.5rem;" },
        h("div", null, h("span", { className: "subtle", style: CAPS, text: "Rx rate  " }), h("b", { text: fmtRate(s.rxBps) || "—" })),
        h("div", null, h("span", { className: "subtle", style: CAPS, text: "Tx rate  " }), h("b", { text: fmtRate(s.txBps) || "—" }))),
      h("div", { style: cols },
        counterBlock("Input errors", INPUT_ERRORS, row),
        counterBlock("Output errors", OUTPUT_ERRORS, row)),
      h("div", { style: cols + "margin-top:.5rem;padding-top:.5rem;border-top:1px solid var(--border);" },
        counterBlock("MAC / PCS / queues", MAC_ERRORS.slice(0, half(MAC_ERRORS)), row),
        counterBlock("", MAC_ERRORS.slice(half(MAC_ERRORS)), row)),
      h("div", { style: cols + "margin-top:.5rem;padding-top:.5rem;border-top:1px solid var(--border);" },
        counterBlock("Traffic", TRAFFIC.filter((k, i) => i % 2 === 0), row),
        counterBlock("", TRAFFIC.filter((k, i) => i % 2 === 1), row)),
      h("div", { className: "subtle", style: "font-size:11px;margin-top:.45rem;", text:
        [row.since ? "Change since " + clock(row.since) : "Baseline sample", fresh].filter(Boolean).join("  ·  ") }),
      rawFields(row, openRaw),
    ]);
}

// Everything the switch (or Mist) sent for the port, so it is plain which
// counters exist. Stays open across refreshes once the user opens it.
function rawFields(row, openRaw) {
  const flat = rawRecord(row.s);
  const keys = Object.keys(flat).sort();
  const box = h("details", { open: openRaw.has(row.item.key), style: "margin-top:.45rem;font-size:12px;" },
    h("summary", { className: "muted", style: "cursor:pointer;", text: "All " + keys.length + " fields " + (row.s.src === "cli" ? "the switch" : "Mist") + " returned for this port" }),
    h("div", { style: "margin-top:.35rem;max-height:14rem;overflow-y:auto;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;" },
      keys.map((k) => h("div", { style: "display:flex;justify-content:space-between;gap:.75rem;padding:1px 0;" },
        h("span", { className: "muted", text: k }),
        h("span", { style: "text-align:right;overflow-wrap:anywhere;min-width:0;", text: flat[k] })))));
  box.addEventListener("toggle", () => { if (box.open) openRaw.add(row.item.key); else openRaw.delete(row.item.key); });
  return box;
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

async function toBlob(made) {
  const out = await made;
  const type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (typeof Blob !== "undefined" && out instanceof Blob) return out;
  if (out instanceof ArrayBuffer || ArrayBuffer.isView(out)) return new Blob([out], { type });
  throw new Error("the toolbox did not return a workbook file");
}

export default {
  id: "port-stats-correlator",
  name: "Port Stats Correlator",
  description: "Follow a flow hop by hop: pick switch ports at any site and watch their \"show interfaces extensive\" counters (errors, drops, CRC, FIFO, MTU, runts, queue drops) side by side, read live from each switch's CLI every few seconds.",
  tag: "Mist API · switch CLI",
  level: "Site · Org",
  needs: { mistToken: true, org: true },
  params: [],

  // The toolbox insists on a run function. This tool works from its own view
  // (mount, below), so run only points the user there.
  async run(ctx) {
    if (ctx && ctx.log) ctx.log("Use the port picker: add ports to the flow and the statistics refresh by themselves.", "info");
    return { summary: "Add ports to the flow in the picker; the statistics then refresh by themselves." };
  },

  async mount(ctx) {
    const root = ctx.mount;
    const log = (m, kind) => { if (ctx.log) ctx.log(m, kind || "info"); };

    const state = {
      sites: [],
      siteId: "",
      switches: [],          // switches at the chosen site
      mac: "",
      ports: [],             // ports on the chosen switch
      ticked: new Set(),     // port ids ticked in the picker
      filter: "",
      upOnly: false,
      flow: [],              // chosen ports, in hop order
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
    };
    const portCache = new Map();   // "site|mac" -> ports
    const openRaw = new Set();     // flow keys whose raw-field list is open
    // "site|mac" -> { refused, until, reason }: switches whose CLI is not used for now.
    const cliDown = new Map();
    let timer = null;

    // ---- elements -------------------------------------------------------
    const siteSel = h("select", { title: "Site", on: { change: () => chooseSite(siteSel.value) } });
    const switchSel = h("select", { title: "Switch", disabled: true, on: { change: () => chooseSwitch(switchSel.value) } });
    const filterBox = h("input", {
      type: "search", placeholder: "Filter ports by name or neighbour…",
      style: "width:auto;flex:1;min-width:14rem;",
      on: { input: () => { state.filter = filterBox.value.trim().toLowerCase(); drawPorts(); } },
    });
    const upOnlyBox = h("input", { type: "checkbox", on: { change: () => { state.upOnly = upOnlyBox.checked; drawPorts(); } } });
    const portsHost = h("div", { style: "margin-top:.85rem;" });
    const addBtn = h("button", { type: "button", className: "btn btn-p", text: "Add selected to flow", disabled: true, on: { click: addTicked } });
    const tickAllBtn = h("button", { type: "button", className: "btn btn-s", text: "Select all shown", on: { click: () => { for (const p of shownPorts()) state.ticked.add(p.port_id); drawPorts(); } } });
    const untickBtn = h("button", { type: "button", className: "btn btn-g", text: "Clear selection", on: { click: () => { state.ticked.clear(); drawPorts(); } } });

    const flowHost = h("div");
    const clearFlowBtn = h("button", { type: "button", className: "btn btn-g", text: "Clear flow", on: { click: () => { state.flow = []; state.cur.clear(); state.base.clear(); flowChanged(); } } });

    const autoBox = h("input", { type: "checkbox", checked: true, on: { change: () => { state.auto = autoBox.checked; state.failedPolls = 0; state.note = ""; schedule(0); drawStatus(); } } });
    const cliBox = h("input", {
      type: "checkbox", checked: true,
      title: "Read the counters from each switch's CLI (show interfaces extensive). Untick to use Mist's port stats only.",
      on: { change: () => { state.useCli = cliBox.checked; cliDown.clear(); state.base = new Map(); state.note = ""; schedule(0); drawStatus(); } },
    });
    const secsBox = h("input", {
      type: "number", min: String(MIN_SECS), max: "3600", step: "1", value: String(DEFAULT_SECS), title: "Seconds between refreshes",
      style: "width:5.5rem;",
      on: { change: () => {
        const n = Math.round(Number(secsBox.value));
        state.secs = isFinite(n) && n >= MIN_SECS ? Math.min(n, 3600) : DEFAULT_SECS;
        secsBox.value = String(state.secs);
        schedule(interval() * 1000);
        drawStatus();
      } },
    });
    const refreshBtn = h("button", { type: "button", className: "btn btn-p", text: "Refresh now", disabled: true, on: { click: () => refresh() } });
    const baselineBtn = h("button", { type: "button", className: "btn btn-s", text: "Reset baseline", disabled: true, title: "Measure the changes from now on", on: { click: () => { state.base = new Map(state.cur); drawResults(); } } });
    const xlsxBtn = h("button", { type: "button", className: "btn btn-s", text: "Download .xlsx", disabled: true, on: { click: saveXlsx } });
    const csvBtn = h("button", { type: "button", className: "btn btn-s", text: "Download .csv", disabled: true, on: { click: saveCsv } });
    const liveDot = h("span", { style: "display:inline-block;width:8px;height:8px;border-radius:99px;margin-right:.45rem;" });
    const statusText = h("span");
    const statusEl = h("div", { className: "muted", style: "font-size:13px;margin-top:.7rem;" }, liveDot, statusText);
    const resultsHost = h("div", { style: "margin-top:1rem;" });

    const step = (n, text) => [h("span", { className: "accent", text: n + "  " }), text];
    const view = h("div", null,
      h("div", { className: "card", style: PANEL },
        h("div", { style: TITLE }, step(1, "Add ports")),
        h("div", { className: "params" },
          h("label", null, h("span", { text: "Site" }), siteSel),
          h("label", null, h("span", { text: "Switch" }), switchSel)),
        h("div", { className: "actions", style: "margin-top:.85rem;" },
          filterBox, h("label", { className: "check" }, upOnlyBox, "Up only"), tickAllBtn, untickBtn, addBtn),
        portsHost,
        h("div", { className: "muted", style: HINT, text: "Pick another site or switch at any time. Ports already in the flow stay there." })),
      h("div", { className: "card", style: PANEL },
        h("div", { className: "row", style: "margin-bottom:.5rem;" }, h("div", { style: TITLE + "margin:0;" }, step(2, "Flow path, in hop order")), clearFlowBtn),
        flowHost),
      h("div", { className: "card", style: PANEL },
        h("div", { style: TITLE }, step(3, "Live statistics")),
        h("div", { className: "actions" },
          h("label", { className: "check" }, autoBox, "Auto-refresh every"),
          secsBox, h("span", { className: "muted", text: "seconds" }),
          h("label", { className: "check", title: cliBox.title }, cliBox, "Live from switch CLI"),
          refreshBtn, baselineBtn, xlsxBtn, csvBtn),
        statusEl,
        resultsHost));
    clear(root, view);

    function fillSelect(sel, firstLabel, options, value) {
      clear(sel, h("option", { value: "", text: firstLabel }), options.map((o) => h("option", { value: o.value, text: o.label })));
      sel.value = value || "";
    }

    // ---- 1. picker ------------------------------------------------------
    async function chooseSite(siteId) {
      state.siteId = siteId;
      state.mac = "";
      state.switches = [];
      state.ports = [];
      state.ticked.clear();
      fillSelect(switchSel, siteId ? "Loading switches…" : "Choose a site first", [], "");
      switchSel.disabled = true;
      drawPorts();
      if (!siteId) return;
      try {
        const devices = await ctx.getAll("/sites/" + siteId + "/stats/devices", { type: "switch" });
        if (state.siteId !== siteId) return;        // the user moved on
        state.switches = (devices || [])
          .filter((d) => d && d.mac)
          .map((d) => ({ mac: String(d.mac).toLowerCase(), name: d.name || ctx.fmtMac(d.mac), model: d.model || "", status: d.status || "" }))
          .sort((a, b) => natural(a.name, b.name));
        fillSelect(switchSel, state.switches.length ? "Choose a switch (" + state.switches.length + ")" : "No switches at this site",
          state.switches.map((s) => ({ value: s.mac, label: s.name + (s.model ? "  ·  " + s.model : "") + (s.status && s.status !== "connected" ? "  ·  " + s.status : "") })), "");
        switchSel.disabled = !state.switches.length;
      } catch (e) {
        fillSelect(switchSel, "Could not load switches", [], "");
        log("Switch list failed: " + e.message, "err");
        drawPorts("Could not load switches: " + e.message);
      }
    }

    function loadPorts(siteId, mac) {
      // Same endpoint the built-in Port Inventory tool uses.
      return ctx.searchAll("/sites/" + siteId + "/stats/ports/search", { device_type: "switch", mac, limit: 1000 })
        .then((records) => latestPerPort(records, mac));
    }

    async function chooseSwitch(mac) {
      state.mac = mac;
      state.ports = [];
      state.ticked.clear();
      if (!mac) { drawPorts(); return; }
      const siteId = state.siteId;
      const cacheKey = siteId + "|" + mac;
      if (!portCache.has(cacheKey)) {
        drawPorts("Loading ports…");
        try {
          portCache.set(cacheKey, await loadPorts(siteId, mac));
        } catch (e) {
          log("Port list failed: " + e.message, "err");
          if (state.siteId === siteId && state.mac === mac) drawPorts("Could not load ports: " + e.message);
          return;
        }
      }
      if (state.siteId !== siteId || state.mac !== mac) return;
      state.ports = portCache.get(cacheKey);
      drawPorts();
    }

    function shownPorts() {
      return state.ports.filter((p) => {
        if (state.upOnly && !p.up) return false;
        if (!state.filter) return true;
        return (p.port_id + " " + neighbourOf(p) + " " + (p.port_usage || "")).toLowerCase().includes(state.filter);
      });
    }

    function drawPorts(message) {
      addBtn.disabled = state.ticked.size === 0;
      addBtn.textContent = state.ticked.size ? "Add " + state.ticked.size + " to flow" : "Add selected to flow";
      if (message || !state.mac) {
        clear(portsHost, h("div", { className: "muted", style: EMPTY, text: message || "Choose a site and a switch to list its ports." }));
        return;
      }
      const shown = shownPorts();
      if (!shown.length) {
        clear(portsHost, h("div", { className: "muted", style: EMPTY, text: state.ports.length ? "No ports match the filter." : "Mist has no port statistics for this switch." }));
        return;
      }
      const inFlow = new Set(state.flow.map((f) => f.key));
      const rows = shown.map((p) => {
        const key = state.siteId + "|" + state.mac + "|" + p.port_id;
        const already = inFlow.has(key);
        const box = h("input", {
          type: "checkbox", style: BOX, checked: state.ticked.has(p.port_id) || already, disabled: already,
          on: { change: () => { if (box.checked) state.ticked.add(p.port_id); else state.ticked.delete(p.port_id); drawPorts(); } },
        });
        return h("tr", { style: already ? "background:" + tint("good", 10) + ";" : "" },
          h("td", { style: CELL + "padding-left:.5rem;" }, box),
          h("td", { style: CELL + "font-weight:600;", text: p.port_id }),
          h("td", { style: CELL, className: linkClass(p.up ? "Up" : "Down"), text: p.up ? "Up" : "Down" }),
          h("td", { style: CELL, text: fmtSpeed(p.speed) }),
          h("td", { style: CELL, className: "muted", text: p.port_usage || "" }),
          h("td", { style: CELL, text: neighbourOf(p) }),
          h("td", { style: CELL }, already ? h("span", { className: "pill good", text: "in flow" }) : null));
      });
      clear(portsHost, scrollBox("18rem", tableOf(["", "Port", "Link", "Speed", "Usage", "Neighbour", ""], rows)));
    }

    function addTicked() {
      const site = state.sites.find((s) => s.id === state.siteId);
      const sw = state.switches.find((s) => s.mac === state.mac);
      if (!site || !sw) return;
      const have = new Set(state.flow.map((f) => f.key));
      for (const p of state.ports) {
        if (!state.ticked.has(p.port_id)) continue;
        const key = site.id + "|" + sw.mac + "|" + p.port_id;
        if (have.has(key)) continue;
        state.flow.push({ key, siteId: site.id, siteName: site.name, mac: sw.mac, switchName: sw.name, portId: p.port_id, neighbour: neighbourOf(p) });
      }
      state.ticked.clear();
      drawPorts();
      flowChanged();
    }

    // ---- 2. flow path ---------------------------------------------------
    // Called after ports are added to or removed from the flow.
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
      drawFlow();
      drawResults();
    }

    function drawFlow() {
      refreshBtn.disabled = state.busy || !state.flow.length;
      clearFlowBtn.disabled = !state.flow.length;
      if (!state.flow.length) {
        clear(flowHost, h("div", { className: "muted", style: EMPTY, text: "No ports yet. Add the ports the flow passes through, from any site." }));
        return;
      }
      const small = "margin-right:.35rem;";
      const off = (flag) => small + (flag ? "opacity:.35;" : "");
      const rows = state.flow.map((f, i) => {
        const now = state.cur.get(f.key);
        const mtu = now && now.s.mtu ? String(now.s.mtu) : "";
        return h("tr", null,
          h("td", { style: CELL, className: "accent", text: i + 1 }),
          h("td", { style: CELL, text: f.siteName }),
          h("td", { style: CELL + "font-weight:600;", text: f.switchName }),
          h("td", { style: CELL + "font-weight:600;", text: f.portId }),
          h("td", { style: CELL, text: mtu }),
          h("td", { style: CELL, className: "muted", text: f.neighbour }),
          h("td", { style: CELL + "text-align:right;padding-right:0;" },
            h("button", { type: "button", className: "chip", text: "↑", title: "Move up", style: off(i === 0), disabled: i === 0, on: { click: () => move(i, -1) } }),
            h("button", { type: "button", className: "chip", text: "↓", title: "Move down", style: off(i === state.flow.length - 1), disabled: i === state.flow.length - 1, on: { click: () => move(i, 1) } }),
            h("button", { type: "button", className: "chip", text: "✕", title: "Remove", style: small, on: { click: () => { state.flow.splice(i, 1); flowChanged(); } } })));
      });
      clear(flowHost, scrollBox("18rem", tableOf(["Hop", "Site", "Switch", "Port", "MTU", "Neighbour", ""], rows)));
    }

    // ---- 3. live statistics ---------------------------------------------
    const switchKey = (f) => f.siteId + "|" + f.mac;

    function cliUsable(k) {
      if (!state.useCli) return false;
      const down = cliDown.get(k);
      return !down || (!down.refused && Date.now() >= down.until);
    }

    function restSwitchCount() {
      return new Set(state.flow.map(switchKey).filter((k) => !cliUsable(k))).size;
    }

    // Seconds between refreshes: what the user asked for, raised when enough
    // switches are on the REST stats that it would press on Mist's hourly limit.
    function interval() {
      return Math.max(state.secs, MIN_SECS, Math.ceil(restSwitchCount() * SECS_PER_REST_SWITCH));
    }

    // The view is gone once the toolbox clears it or the tool is opened again.
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
      if (visible() && !state.busy) await collect();
      schedule(interval() * 1000);
    }

    async function refresh() {
      state.failedPolls = 0;
      state.note = "";
      await collect();
      schedule(interval() * 1000);
    }

    // One switch's ports, from its CLI, one command per port.
    async function readCli(g, fresh) {
      for (const item of g.items) {
        const json = await ctx.junosShow(g.siteId, g.mac, "show interfaces extensive " + item.portId);
        const iface = interfaceCounters(json).find((r) => r.name === item.portId) || interfaceCounters(json)[0];
        if (iface) fresh.set(item.key, { t: Date.now(), s: cliSample(iface) });
      }
    }

    // One switch's ports, from Mist's REST stats.
    async function readRest(g, fresh) {
      const ports = await loadPorts(g.siteId, g.mac);
      portCache.set(g.siteId + "|" + g.mac, ports);
      const t = Date.now();
      const byId = new Map(ports.map((p) => [p.port_id, p]));
      for (const item of g.items) {
        const p = byId.get(item.portId);
        if (p) fresh.set(item.key, { t, s: restSample(p) });
      }
    }

    async function collect() {
      if (state.busy || !state.flow.length) return;
      state.busy = true;
      refreshBtn.disabled = true;
      drawStatus();

      const groups = new Map();           // one job per switch
      for (const f of state.flow) {
        const k = switchKey(f);
        if (!groups.has(k)) groups.set(k, { key: k, siteId: f.siteId, mac: f.mac, name: f.switchName, items: [] });
        groups.get(k).items.push(f);
      }
      const list = [...groups.values()];
      const errors = [];
      const fresh = new Map();
      try {
        await ctx.pool(ctx.POOL_LIMIT || 6, list.map((g) => async () => {
          if (cliUsable(g.key)) {
            try {
              await readCli(g, fresh);
              if (cliDown.has(g.key)) { cliDown.delete(g.key); log(g.name + ": reading the switch CLI again.", "ok"); }
              return;
            } catch (e) {
              const refused = isRefusal(e.message);
              cliDown.set(g.key, { refused, until: Date.now() + CLI_RETRY_MS, reason: e.message });
              log(g.name + ": switch CLI not available (" + e.message + "). Using Mist's port stats"
                + (refused ? "." : " and trying the CLI again in a minute."), "err");
            }
          }
          try {
            await readRest(g, fresh);
          } catch (e) {
            errors.push(g.name + ": " + e.message);
          }
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
        state.note = errors.length ? errors.length + " switch" + (errors.length === 1 ? "" : "es") + " did not answer (see the log)" : "";
        // Ports that failed this round keep their last good sample.
        const keys = new Set(state.flow.map((f) => f.key));
        for (const k of [...state.cur.keys()]) if (!keys.has(k)) state.cur.delete(k);
        for (const k of [...state.base.keys()]) if (!keys.has(k)) state.base.delete(k);
        for (const [k, v] of fresh) {
          state.cur.set(k, v);
          // A new port, or one whose source changed, starts a new baseline.
          const b = state.base.get(k);
          if (!b || b.s.src !== v.s.src) state.base.set(k, v);
        }
        state.polls += 1;
        state.lastUpdate = Date.now();
        if (state.polls === 1) log("Live statistics started for " + state.flow.length + " port" + (state.flow.length === 1 ? "" : "s") + ".", "ok");
      }
      drawFlow();
      drawResults();
    }

    function currentRows() {
      return buildRows(state.flow, state.cur, state.base);
    }

    function drawStatus() {
      const live = state.auto && state.flow.length > 0;
      liveDot.style.background = state.note && !live ? "var(--crit)" : live ? "var(--good)" : "var(--subtle)";
      const parts = [];
      if (!state.flow.length) parts.push("Waiting for ports");
      else if (live) {
        const want = state.secs;
        const real = interval();
        parts.push("Live, every " + real + " s" + (real > want ? " (raised from " + want + " s for " + restSwitchCount() + " switches on Mist stats, to stay inside Mist's hourly API limit)" : ""));
      } else parts.push("Paused");
      const switches = new Set(state.flow.map(switchKey));
      const viaCli = [...switches].filter(cliUsable).length;
      if (switches.size) {
        parts.push(viaCli === switches.size ? "all switches read over the CLI"
          : viaCli === 0 ? (state.useCli ? "Mist stats only (switch CLI not available)" : "Mist stats only")
            : viaCli + " of " + switches.size + " switches over the CLI, the rest from Mist stats");
      }
      if (state.busy) parts.push("refreshing…");
      else if (state.lastUpdate) parts.push("updated " + clock(state.lastUpdate));
      if (state.note) parts.push(state.note);
      statusText.textContent = parts.join("  ·  ");
    }

    function drawResults() {
      const has = state.cur.size > 0 && state.flow.length > 0;
      xlsxBtn.disabled = !has;
      csvBtn.disabled = !has;
      baselineBtn.disabled = !has;
      drawStatus();
      if (!has) {
        clear(resultsHost, h("div", { className: "muted", style: EMPTY, text: state.flow.length ? "Collecting the first sample…" : "Add ports to the flow and their statistics appear here, refreshed automatically." }));
        return;
      }
      const data = currentRows();
      const newErrors = data.reduce((n, r) => n + r.newErrors, 0);
      const mtu = smallestMtu(data);
      const tiles = [
        tile(data.length, "Hops in flow", "#1f4e78"),
        tile(data.filter((r) => r.s && r.s.up).length, "Links up", "var(--good)"),
        tile(data.filter((r) => r.s && !r.s.up).length, "Links down", "var(--warn)"),
        tile(data.filter((r) => r.newErrors > 0).length, "Hops with new errors", "var(--crit)"),
        tile(fmtInt(newErrors), "New errors and drops since baseline", "var(--crit)"),
        tile(mtu ? String(mtu.mtu) : "—", mtu ? (mtu.uniform ? "MTU, same on every hop" : "Smallest MTU, hop " + mtu.hops.join(", ")) : "MTU (switch CLI only)", mtu && !mtu.uniform ? "var(--warn)" : "var(--subtle)"),
        tile(data.filter((r) => !r.s).length, "No data", "var(--subtle)"),
      ];
      clear(resultsHost,
        h("div", { style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:1rem;" }, tiles),
        h("div", { style: "display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,23rem),1fr));gap:10px;" }, data.map((r) => portTile(r, ctx, openRaw))),
        h("div", { className: "muted", style: HINT, text:
          "Each tile follows \"show interfaces extensive\", read from the switch's CLI. Green +numbers are traffic since the baseline; "
          + "red means an error or drop counter grew. A dash means the counter is not available: the Mist stats fallback only carries total errors, "
          + "and only once a minute." }));
    }

    // ---- export ---------------------------------------------------------
    function exportData() {
      const rows = currentRows();
      const columns = [
        { header: "Hop", key: "hop" }, { header: "Site", key: "site" }, { header: "Switch", key: "switch" }, { header: "Port", key: "port" },
        { header: "Source", key: "src" }, { header: "Link", key: "link" }, { header: "Speed", key: "speed" }, { header: "Duplex", key: "duplex" },
        { header: "MTU", key: "mtu" }, { header: "Rx bps", key: "rx_bps" }, { header: "Tx bps", key: "tx_bps" },
        { header: "Baseline", key: "since" }, { header: "Sampled", key: "sampled" },
      ];
      for (const k of ALL_COUNTERS) {
        columns.push({ header: k.label + " (" + k.key + ")", key: k.key });
        columns.push({ header: "Δ " + k.label, key: "d_" + k.key });
      }
      const blank = (v) => (v === null || v === undefined ? "" : v);
      const flowRows = rows.map((r) => {
        const s = r.s;
        const out = {
          hop: r.hop, site: r.item.siteName, switch: r.item.switchName, port: r.item.portId,
          src: s ? (s.src === "cli" ? "Switch CLI" : "Mist stats") : "",
          link: s ? (s.up ? "Up" : "Down") : "No data", speed: s ? s.speed : "", duplex: s ? s.duplex : "",
          mtu: blank(s && s.mtu), rx_bps: blank(s && s.rxBps), tx_bps: blank(s && s.txBps),
          since: r.since ? ctx.epochToUtc(r.since) : "", sampled: r.t ? ctx.epochToUtc(r.t) : "",
        };
        for (const k of ALL_COUNTERS) {
          out[k.key] = blank(r.vals[k.key].v);
          out["d_" + k.key] = blank(r.vals[k.key].d);
        }
        if (r.state === "errors" || r.state === "nodata") out.__style = "red";
        else if (r.state === "down") out.__style = "yellow";
        return out;
      });
      return { columns, flowRows, rows };
    }

    function rawSheet(rows) {
      const recs = rows.map((r) => rawRecord(r.s));
      const keys = new Set();
      for (const rec of recs) for (const k of Object.keys(rec)) keys.add(k);
      const fields = [...keys].sort();
      const columns = [{ header: "Hop", key: "__hop" }, { header: "Site", key: "__site" }, { header: "Switch", key: "__switch" },
        ...fields.map((k) => ({ header: k, key: k }))];
      const out = rows.map((r, i) => ({ __hop: r.hop, __site: r.item.siteName, __switch: r.item.switchName, ...recs[i] }));
      return ctx.xlsx.sheet("All fields", columns, out, { tabColor: "7F7F7F" });
    }

    async function saveXlsx() {
      try {
        const { columns, flowRows, rows } = exportData();
        const sheets = [
          ctx.xlsx.sheet("Flow", columns, flowRows, { tabColor: "1F4E78" }),
          rawSheet(rows),
          ctx.xlsx.sheet("Info", [{ header: "Field" }, { header: "Value" }], [
            ["Org", ctx.orgName || ""],
            ["Ports in flow", state.flow.length],
            ["Sites", [...new Set(state.flow.map((f) => f.siteName))].join(", ")],
            ["Last refresh", state.lastUpdate ? ctx.epochToUtc(state.lastUpdate) : ""],
            ["Refreshes", state.polls],
            ["Note", "Counters come from \"show interfaces extensive\" on each switch (Source: Switch CLI), or from Mist's port stats when the CLI was not available (Source: Mist stats, total errors only). Δ columns are the change since the Baseline time."],
          ], { autofilter: false, freeze: null }),
        ];
        const blob = await toBlob(ctx.xlsx.workbook(sheets));
        const name = ctx.stampedName("mist_port_stats", ctx.orgName, "xlsx");
        ctx.download(blob, name);
        log("Saved " + name, "ok");
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
        const name = ctx.stampedName("mist_port_stats", ctx.orgName, "csv");
        ctx.download(new Blob([text], { type: "text/csv;charset=utf-8" }), name);
        log("Saved " + name, "ok");
      } catch (e) {
        log("Could not save the .csv: " + e.message, "err");
        state.note = "Could not save the .csv: " + e.message;
        drawStatus();
      }
    }

    // ---- start ----------------------------------------------------------
    fillSelect(siteSel, "Loading sites…", [], "");
    fillSelect(switchSel, "Choose a site first", [], "");
    drawPorts();
    drawFlow();
    drawResults();
    if (ctx.access && ctx.access.level && !["admin", "write", "unknown"].includes(ctx.access.level)) {
      log("Your token is " + (ctx.access.label || ctx.access.level) + ". Mist only opens switch CLI sessions for admin-level tokens, so this tool will likely use Mist's port stats (total errors only, about once a minute).", "info");
    }
    try {
      state.sites = await ctx.listSites();
      fillSelect(siteSel, "Choose a site (" + state.sites.length + ")", state.sites.map((s) => ({ value: s.id, label: s.name })), "");
    } catch (e) {
      fillSelect(siteSel, "Could not load sites", [], "");
      log("Site list failed: " + e.message, "err");
      drawPorts("Could not load sites: " + e.message);
    }
  },
};
