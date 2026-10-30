// Client Wi-Fi PHY Inspector: every physical-layer facet of one wireless
// client's connection, graded against published thresholds and drawn as a
// colour-coded dashboard, plus an .xlsx of the raw numbers.
//
// Data (all GET, site found automatically when "All sites in the org" is ticked):
//   /orgs/{org}/clients/search?mac=                 which site saw the client last
//   /sites/{site}/stats/clients/{mac}               live RSSI, SNR, rates, retries, band, proto
//   /sites/{site}/clients/search?mac=               last-known record if it is offline
//   /sites/{site}/clients/{mac}/events              joins, roams, deauths + 802.11 reason codes
//   /sites/{site}/clients/sessions/search?mac=      per-AP sessions (roaming timeline)
//   /sites/{site}/stats/devices?type=ap             serving radio: channel, width, power,
//                                                   noise floor, utilisation; site channel map
//   /const/insight_metrics, then
//   /sites/{site}/insights/client/{mac}/{metric}    time series (path form; the ?metrics= form 404s)
//
// Grading thresholds (edit THRESHOLDS below to suit your own design targets):
//   RSSI   >= -65 good | -65..-70 warning | -70..-75 serious | < -75 critical (dBm)
//          -67 dBm is the common voice/video design target; the toolbox's
//          Disconnect Console treats < -75 dBm as a coverage-hole signature.
//   SNR    >= 25 good | 20..25 warning | 15..20 serious | < 15 critical (dB)
//   Noise  <= -90 good | -90..-85 warning | -85..-80 serious | > -80 critical (dBm)
//   Retries, channel utilisation, non-Wi-Fi share, PHY-rate efficiency: see THRESHOLDS.

import { deviceRadioMacs } from "../engine/normalize.js";
import { bandGroup, describeReason, isNegative, normalizeMac, num, utilPct } from "../engine/util.js";

// ---- Thresholds and palette ---------------------------------------------

// cuts = [good-from, warning-from, serious-from]; hb = higher is better.
const THRESHOLDS = {
  rssi: { cuts: [-65, -70, -75], hb: true, min: -95, max: -30, unit: "dBm" },
  snr: { cuts: [25, 20, 15], hb: true, min: 0, max: 50, unit: "dB" },
  noise: { cuts: [-90, -85, -80], hb: false, min: -100, max: -60, unit: "dBm" },
  retry: { cuts: [10, 20, 30], hb: false, min: 0, max: 50, unit: "%" },
  util: { cuts: [50, 70, 85], hb: false, min: 0, max: 100, unit: "%" },
  nonwifi: { cuts: [10, 20, 35], hb: false, min: 0, max: 60, unit: "%" },
  eff: { cuts: [60, 40, 20], hb: true, min: 0, max: 100, unit: "%" },
  cochannel: { cuts: [1, 3, 6], hb: false, min: 0, max: 10, unit: "APs" },
  load: { cuts: [30, 50, 75], hb: false, min: 0, max: 100, unit: "clients" },
};

// Status palette (fixed, never reused for series) and dark categorical slots.
const STATUS = {
  critical: { color: "#d03b3b", icon: "✕", label: "Critical" },
  serious: { color: "#ec835a", icon: "▲", label: "Serious" },
  warning: { color: "#fab219", icon: "!", label: "Warning" },
  good: { color: "#0ca30c", icon: "✓", label: "Good" },
  unknown: { color: "#6e7480", icon: "–", label: "No data" },
};
const RANK = { critical: 0, serious: 1, warning: 2, good: 3, unknown: 4 };
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const BAND = {
  24: { label: "2.4 GHz", color: SERIES[1] },
  5: { label: "5 GHz", color: SERIES[0] },
  6: { label: "6 GHz", color: SERIES[2] },
  unk: { label: "Unknown band", color: "#6e7480" },
};

// Highest single-stream PHY rate (Mbps) by generation and channel width:
// HE MCS11 / EHT MCS13 at 0.8 us GI, VHT MCS9 / HT MCS7 at short GI.
const PER_STREAM_MAX = {
  be: { 20: 172.1, 40: 344.1, 80: 720.6, 160: 1441.2, 320: 2882.4 },
  ax: { 20: 143.4, 40: 286.8, 80: 600.5, 160: 1201 },
  ac: { 20: 86.7, 40: 200, 80: 433.3, 160: 866.7 },
  n: { 20: 72.2, 40: 150 },
};
const GENERATION = {
  be: { label: "Wi-Fi 7 (802.11be)", sev: "good" },
  ax: { label: "Wi-Fi 6/6E (802.11ax)", sev: "good" },
  ac: { label: "Wi-Fi 5 (802.11ac)", sev: "good" },
  n: { label: "Wi-Fi 4 (802.11n)", sev: "warning" },
  a: { label: "802.11a (legacy)", sev: "serious" },
  g: { label: "802.11g (legacy)", sev: "serious" },
  b: { label: "802.11b (legacy)", sev: "critical" },
};
const ASSUMED_STREAMS = 2;

// 20 MHz channel plans. A wider channel occupies an aligned block of these.
const PLAN_5 = [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144,
  149, 153, 157, 161, 165, 169, 173, 177];
const SEGMENTS_5 = [[36, 64], [100, 144], [149, 177]];
const DFS_5 = [52, 144];

/** [lowest, highest] 20 MHz channel a radio occupies, from its primary channel and width. */
function span(band, ch, width) {
  const n = Math.max(1, Math.round((width || 20) / 20));
  if (band === "24") return [Math.max(1, ch - 2), Math.min(14, ch + (n > 1 ? 6 : 2))];
  if (band === "5") {
    const seg = SEGMENTS_5.find(([lo, hi]) => ch >= lo && ch <= hi);
    if (!seg) return [ch, ch];
    const chans = PLAN_5.filter((c) => c >= seg[0] && c <= seg[1]);
    const p = chans.indexOf(ch);
    if (p < 0) return [ch, ch];
    const start = Math.floor(p / n) * n;
    return [chans[start], chans[Math.min(chans.length - 1, start + n - 1)]];
  }
  if (band === "6") {
    const start = Math.floor((ch - 1) / 4 / n) * n;
    return [1 + start * 4, 1 + (start + n - 1) * 4];
  }
  return [ch, ch];
}
const overlaps = (a, b) => a[0] <= b[1] && b[0] <= a[1];

function channelPlan(band, occ) {
  const hi = Math.max(0, ...occ.map((o) => o.span[1]));
  const lo = Math.min(...occ.map((o) => o.span[0]));
  if (band === "24") return Array.from({ length: hi > 13 ? 14 : 13 }, (_, i) => i + 1);
  if (band === "5") return PLAN_5.filter((c) => c <= Math.max(165, hi));
  if (band === "6") {
    const all = Array.from({ length: 59 }, (_, i) => 1 + i * 4);
    return all.filter((c) => c >= lo - 16 && c <= hi + 16);
  }
  return [];
}

// ---- Small helpers -------------------------------------------------------

const list = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
const first = (v) => (Array.isArray(v) ? v.find((x) => x != null && x !== "") : v);
const epoch = (t) => { const n = num(t); return n === null ? null : n > 1e12 ? n / 1000 : n; };
const pick = (...vals) => { for (const v of vals) { const f = first(v); if (f != null && f !== "") return f; } return null; };
const pct = (part, whole) => (whole > 0 ? (part / whole) * 100 : null);
const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const results = (res) => (Array.isArray(res) ? res : list(res?.results ?? res?.data));
const worst = (sevs) => sevs.reduce((w, s) => (RANK[s] < RANK[w] ? s : w), "unknown");

// Axis ticks on round steps (1, 2, 2.5, 5 x 10^n) inside [lo, hi].
function niceTicks(lo, hi, count = 5) {
  const raw = (hi - lo) / (count - 1) || 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

function grade(v, t) {
  if (v == null || Number.isNaN(v)) return "unknown";
  const [a, b, c] = t.cuts;
  if (t.hb) return v >= a ? "good" : v >= b ? "warning" : v >= c ? "serious" : "critical";
  return v <= a ? "good" : v <= b ? "warning" : v <= c ? "serious" : "critical";
}

function zones(t) {
  const [a, b, c] = t.cuts;
  return t.hb
    ? [{ from: t.min, to: c, sev: "critical" }, { from: c, to: b, sev: "serious" },
       { from: b, to: a, sev: "warning" }, { from: a, to: t.max, sev: "good" }]
    : [{ from: t.min, to: a, sev: "good" }, { from: a, to: b, sev: "warning" },
       { from: b, to: c, sev: "serious" }, { from: c, to: t.max, sev: "critical" }];
}

function protoKey(p) {
  const s = String(p || "").toLowerCase().replace(/^802\.11/, "");
  for (const k of ["be", "ax", "ac", "n", "a", "g", "b"]) if (s === k || s.endsWith(k)) return k;
  return "";
}

function phyCeiling(proto, width, streams) {
  if (proto === "a" || proto === "g") return 54;
  if (proto === "b") return 11;
  const table = PER_STREAM_MAX[proto];
  if (!table) return null;
  const w = table[width] ? width : Math.max(...Object.keys(table).map(Number).filter((x) => x <= (width || 20)), 20);
  return table[w] ? table[w] * Math.min(Math.max(streams, 1), 4) : null;
}

// Insight responses vary by metric: {rt:[...], results:[...]}, {rt, <key>:[...]},
// or results:[{timestamp, ...}]. Pull every numeric series out of whatever came back.
function parseSeries(res, metric) {
  const out = [];
  if (!res || typeof res !== "object") return out;
  const toPts = (ts, vals) => ts.map((t, i) => [epoch(t), num(vals[i])]).filter(([t, v]) => t !== null && v !== null);
  const rt = Array.isArray(res.rt) ? res.rt : null;
  if (rt) {
    for (const [k, arr] of Object.entries(res)) {
      if (k === "rt" || !Array.isArray(arr) || arr.length !== rt.length) continue;
      const base = k === "results" ? metric : `${metric}.${k}`;
      if (arr.some((x) => x && typeof x === "object")) {
        const keys = new Set();
        arr.forEach((o) => o && typeof o === "object" && Object.keys(o).forEach((kk) => keys.add(kk)));
        for (const kk of keys) {
          const pts = toPts(rt, arr.map((o) => o?.[kk]));
          const name = `${base}.${kk}`;
          if (pts.length) out.push({ name, pts });
        }
      } else {
        const pts = toPts(rt, arr);
        const name = base;
        if (pts.length) out.push({ name, pts });
      }
    }
  } else if (Array.isArray(res.results)) {
    const keys = new Set();
    res.results.forEach((o) => o && typeof o === "object" && Object.keys(o).forEach((k) => keys.add(k)));
    keys.delete("timestamp");
    for (const k of keys) {
      const pts = res.results.map((o) => [epoch(o?.timestamp), num(o?.[k])]).filter(([t, v]) => t !== null && v !== null);
      const name = k === "value" ? metric : `${metric}.${k}`;
      if (pts.length) out.push({ name, pts });
    }
  }
  return out;
}

// tx_rate + rx_rate share a chart (same unit, one axis); rssi and snr get their own.
function family(name) {
  const n = name.toLowerCase();
  if (/rssi/.test(n)) return "rssi";
  if (/snr/.test(n)) return "snr";
  if (/retr/.test(n)) return "retries";
  if (/bps/.test(n)) return "bps";
  if (/rate|mcs/.test(n)) return "rate";
  if (/bytes/.test(n)) return "bytes";
  if (/pkts|packets/.test(n)) return "pkts";
  return n.replace(/(^|[._])(tx|rx)(?=[._]|$)/g, "$1").replace(/[._]+/g, "_").replace(/^_|_$/g, "") || n;
}
const FAMILY_META = {
  rssi: { title: "Signal strength (RSSI)", unit: "dBm", t: THRESHOLDS.rssi },
  snr: { title: "Signal-to-noise ratio (SNR)", unit: "dB", t: THRESHOLDS.snr },
  rate: { title: "PHY data rate", unit: "Mbps" },
  bps: { title: "Throughput", unit: "bps" },
  retries: { title: "Retries", unit: "" },
  pkts: { title: "Packets", unit: "" },
  bytes: { title: "Bytes", unit: "bytes" },
};
const FAMILY_ORDER = ["rssi", "snr", "rate", "bps", "retries", "pkts", "bytes"];

// ---- The tool --------------------------------------------------------------

export default {
  id: "client-wifi-phy",
  name: "Client Wi-Fi PHY Inspector",
  description:
    "Examines every physical-layer facet of one wireless client: RSSI, SNR, noise floor, PHY rate " +
    "against its ceiling, retries, band, Wi-Fi generation, channel load and interference, co-channel " +
    "APs and roaming, with colour-coded charts that highlight what is wrong.",
  tag: "Mist API",
  level: "Site · Client",
  notice: "Shows client identity (hostname, IP, username). Treat the export as personal data.",
  needs: { mistToken: true, org: true },
  scope: "site",
  params: [
    {
      id: "mac",
      label: "Client MAC",
      placeholder: "aa:bb:cc:dd:ee:ff",
      hint: "Any format. With \"All sites in the org\" ticked, the tool finds the client's site.",
    },
    {
      id: "duration",
      type: "select",
      label: "Look back",
      options: [
        { value: "1d", label: "Past 1 day" },
        { value: "7d", label: "Past 7 days" },
      ],
      default: "1d",
    },
  ],

  async run(ctx) {
    const mac = normalizeMac(ctx.params.mac);
    const duration = ctx.params.duration === "7d" ? "7d" : "1d";
    const durS = duration === "7d" ? 7 * 86400 : 86400;
    const now = Date.now() / 1000;
    const scope = await ctx.targetSites();
    const siteName = (id) => scope.orgSites.find((s) => s.id === id)?.name || id;

    // ---- 1. Which site? -----------------------------------------------------
    let siteId = scope.all ? null : scope.sites[0].id;
    if (!siteId) {
      ctx.status("Finding the client…");
      let hits = [];
      try {
        hits = results(await ctx.searchAll(`/orgs/${ctx.orgId}/clients/search`, { mac, duration, limit: 100 }));
      } catch (e) {
        ctx.log(`Org-wide client search unavailable (${e.message}); checking each site`, "info");
        let done = 0;
        const per = await ctx.pool(ctx.POOL_LIMIT, scope.sites.map((s) => async () => {
          if (ctx.signal.aborted) return null;
          try { const r = await ctx.mistGet(`/sites/${s.id}/stats/clients/${mac}`); return r ? { ...r, site_id: s.id } : null; }
          catch { return null; } finally { ctx.progress(++done, scope.sites.length, s.name); }
        }));
        hits = per.filter(Boolean);
      }
      hits = hits.filter((h) => h?.site_id && scope.orgSites.some((s) => s.id === h.site_id))
        .sort((a, b) => (epoch(pick(b.last_seen, b.timestamp)) || 0) - (epoch(pick(a.last_seen, a.timestamp)) || 0));
      if (!hits.length) throw new Error(`Client ${formatMac(mac)} was not seen at any site in the ${duration === "7d" ? "past 7 days" : "past day"}.`);
      siteId = hits[0].site_id;
      ctx.log(`Client found at ${siteName(siteId)}`, "ok");
    }
    if (ctx.signal.aborted) throw new Error("Cancelled.");

    // ---- 2. Collect -----------------------------------------------------------
    ctx.status(`Reading ${formatMac(mac)} at ${siteName(siteId)}…`);
    const soft = async (label, fn) => {
      try { return await fn(); } catch (e) { ctx.log(`${label}: ${e.message}`, "info"); return null; }
    };
    const [stats, search, events, sessions, aps, catalog] = await Promise.all([
      soft("Live stats", () => ctx.mistGet(`/sites/${siteId}/stats/clients/${mac}`)),
      soft("Client history", () => ctx.searchAll(`/sites/${siteId}/clients/search`, { mac, duration, limit: 100 })),
      soft("Client events", () => ctx.mistGet(`/sites/${siteId}/clients/${mac}/events`, { duration, limit: 1000 })),
      soft("Sessions", () => ctx.searchAll(`/sites/${siteId}/clients/sessions/search`, { mac, duration, limit: 100 })),
      soft("AP stats", () => ctx.getAll(`/sites/${siteId}/stats/devices`, { type: "ap" })),
      soft("Insight metric list", () => ctx.mistGet("/const/insight_metrics")),
    ]);
    ctx.progress(1, 3, "Client data");

    const hist = results(search).sort((a, b) => (epoch(pick(b.last_seen, b.timestamp)) || 0) - (epoch(pick(a.last_seen, a.timestamp)) || 0));
    const last = hist[0] || {};
    const live = stats && typeof stats === "object" && !Array.isArray(stats) && Object.keys(stats).length ? stats : null;
    const c = live || {};

    // ---- 3. Insight time series ---------------------------------------------
    const PHY_RE = /rssi|snr|rate|bps|retr|mcs|stream|noise|util|pkts|bytes|power/i;
    let metrics = [];
    if (catalog && typeof catalog === "object") {
      const entries = Array.isArray(catalog)
        ? catalog.map((m) => [m?.key || m?.name || m?.metric, m])
        : Object.entries(catalog);
      metrics = entries
        .filter(([k, m]) => k && (!m?.scopes || list(m.scopes).map(String).includes("client")))
        .filter(([, m]) => !m?.type || /time/i.test(String(m.type)))
        .map(([k]) => String(k));
      const phy = metrics.filter((m) => PHY_RE.test(m));
      metrics = (phy.length ? phy : metrics).slice(0, 14);
    }
    if (!metrics.length) {
      metrics = ["rssi", "snr", "tx_rate", "rx_rate", "tx_bps", "rx_bps", "tx_retries", "rx_retries", "tx_bytes", "rx_bytes"];
    }
    ctx.status("Reading client time series…");
    const interval = duration === "7d" ? 3600 : 600;
    let missing = 0;
    const seriesSets = await ctx.pool(ctx.POOL_LIMIT, metrics.map((m) => async () => {
      if (ctx.signal.aborted) return [];
      try {
        const res = await ctx.mistGet(`/sites/${siteId}/insights/client/${mac}/${encodeURIComponent(m)}`, { duration, interval });
        return parseSeries(res, m);
      } catch { missing += 1; return []; }
    }));
    if (ctx.signal.aborted) throw new Error("Cancelled.");
    const series = seriesSets.flat().filter((s) => s.pts.length >= 2);
    if (missing) ctx.log(`${missing} of ${metrics.length} insight metric(s) returned nothing for this client`, "info");
    ctx.progress(2, 3, "Time series");

    // RSSI/SNR fallback: per-record readings in events and history.
    const harvest = (rows, field) => rows.map((r) => [epoch(pick(r.timestamp, r.last_seen)), num(r?.[field])])
      .filter(([t, v]) => t !== null && v !== null && t >= now - durS);
    const evRows = results(events);
    for (const f of ["rssi", "snr"]) {
      if (!series.some((s) => family(s.name) === f)) {
        const pts = [...harvest(evRows, f), ...harvest(hist, f)].sort((a, b) => a[0] - b[0]);
        if (pts.length >= 2) series.push({ name: `${f} (event readings)`, pts });
      }
    }

    // ---- 4. Shape -------------------------------------------------------------
    const apList = (aps || []).filter((d) => !d.type || d.type === "ap");
    const hex = (m) => String(m || "").toLowerCase().replace(/[^0-9a-f]/g, "");
    // Mist names the client's AP by base MAC or by a radio BSSID; match either.
    const apKeys = apList.map((a) => ({ a, macs: new Set([hex(a.mac), ...deviceRadioMacs(a)]) }));
    const findAp = (m) => {
      const h = hex(m);
      if (h.length !== 12) return null;
      const exact = apKeys.find((k) => k.macs.has(h));
      if (exact) return exact.a;
      // A BSSID is the AP's base MAC plus a small offset in the low bits. APs from
      // one batch share most of their MAC, so take the closest base MAC at or
      // below the BSSID, within 32 addresses.
      const low = (x) => parseInt(x.slice(6), 16);
      let best = null;
      for (const k of apKeys) {
        const m = hex(k.a.mac);
        if (m.slice(0, 6) !== h.slice(0, 6)) continue;
        const diff = low(h) - low(m);
        if (diff >= 0 && diff < 32 && (!best || diff < best.diff)) best = { a: k.a, diff };
      }
      return best ? best.a : null;
    };
    const apCandidates = [c.ap_mac, c.ap, c.bssid, last.last_ap, last.ap, last.bssid].map(first).filter(Boolean);
    const servingAp = apCandidates.map(findAp).find(Boolean) || null;
    const apMac = servingAp ? hex(servingAp.mac) : hex(apCandidates[0]);
    if (!servingAp && apCandidates.length) ctx.log(`Serving AP ${formatMac(apCandidates[0])} not found in this site's AP stats`, "info");
    const apName = (m) => findAp(m)?.name || (m ? formatMac(m) : "");

    const band = bandGroup(pick(c.band, last.band, last.last_band));
    const radio = servingAp?.radio_stat?.[`band_${band}`] || null;
    const proto = protoKey(pick(c.proto, c.protocol, last.proto, last.last_proto));
    const streamsKnown = num(pick(c.num_streams, c.streams, c.nss));
    const streams = streamsKnown || ASSUMED_STREAMS;

    const rssi = num(pick(c.rssi, last.rssi, last.last_rssi));
    const snr = num(pick(c.snr, last.snr, last.last_snr));
    const noise = num(pick(radio?.noise_floor, c.noise_floor));
    const txRate = num(c.tx_rate);
    const rxRate = num(c.rx_rate);
    const bestRate = Math.max(txRate || 0, rxRate || 0) || null;

    // Channel width: reported, or else the narrowest width whose ceiling covers
    // the rate the client actually achieved (a 573 Mbps HE link is at least 80 MHz).
    let width = num(pick(c.channel_width, c.bandwidth, radio?.bandwidth)) || (band === "24" ? 20 : null);
    const widthInferred = !width;
    if (!width) width = [20, 40, 80, 160, 320].find((w) => (phyCeiling(proto, w, streams) || 0) >= (bestRate || 0)) || 20;
    const ceiling = phyCeiling(proto, width, streams);
    const eff = bestRate && ceiling ? Math.min(100, pct(bestRate, ceiling)) : null;
    const widthLabel = `${width} MHz${widthInferred ? " (inferred)" : ""}`;
    const txRetries = num(c.tx_retries); const rxRetries = num(c.rx_retries);
    const txPkts = num(c.tx_pkts); const rxPkts = num(c.rx_pkts);
    const txRetryPct = txRetries != null && txPkts ? pct(txRetries, txPkts + txRetries) : null;
    const rxRetryPct = rxRetries != null && rxPkts ? pct(rxRetries, rxPkts + rxRetries) : null;
    const retryPct = [txRetryPct, rxRetryPct].filter((v) => v != null).reduce((m, v) => Math.max(m, v), -1);
    const u = (k) => (radio && radio[k] != null ? utilPct(radio[k]) : null);
    const util = {
      all: u("util_all"), tx: u("util_tx"), inBss: u("util_rx_in_bss"), otherBss: u("util_rx_other_bss"),
      unknownWifi: u("util_unknown_wifi"), nonWifi: u("util_non_wifi"),
    };
    const channel = num(pick(c.channel, radio?.channel, last.channel));
    const radioClients = num(radio?.num_clients);

    // Channel occupancy: every AP radio in the client's band, as the 20 MHz channels
    // it spans. Co-channel means any overlap with the serving radio, not just the
    // same primary channel (an 80 MHz radio on 36 also occupies 40, 44 and 48).
    const occ = apList.map((a) => {
      const r = a.radio_stat?.[`band_${band}`];
      const ch = num(r?.channel);
      if (ch == null) return null;
      const w = num(r?.bandwidth) || 20;
      return {
        name: a.name || formatMac(a.mac), mac: hex(a.mac), ch, width: w, span: span(band, ch, w),
        clients: num(r?.num_clients), util: r?.util_all != null ? utilPct(r.util_all) : null, serving: a === servingAp,
      };
    }).filter(Boolean);
    if (channel != null && !occ.some((o) => o.serving)) {
      occ.push({ name: servingAp?.name || (apMac ? formatMac(apMac) : "Serving AP"), mac: apMac, ch: channel,
        width: width || 20, span: span(band, channel, width || 20), clients: radioClients, util: util.all, serving: true });
    }
    const servingOcc = occ.find((o) => o.serving) || null;
    const coChannel = servingOcc ? occ.filter((o) => !o.serving && overlaps(o.span, servingOcc.span)) : [];
    const samePrimary = servingOcc ? coChannel.filter((o) => o.ch === servingOcc.ch).length : 0;

    const evs = evRows.map((e) => {
      const reason = pick(e.reason_code, e.reason);
      return {
        t: epoch(e.timestamp) || 0, type: String(e.type || "unknown"), text: String(e.text || ""),
        ap: e.ap || "", band: bandGroup(e.band), channel: e.channel ?? "", reason,
        reasonText: describeReason(reason) || "", negative: isNegative(e.type || "", e.text || ""),
      };
    }).sort((a, b) => a.t - b.t);
    const negEvents = evs.filter((e) => e.negative);
    const reasonCounts = new Map();
    for (const e of negEvents) {
      const k = e.reasonText ? `Reason ${e.reasonText}` : e.type.replace(/^CLIENT_|^MARVIS_EVENT_CLIENT_/, "").replace(/_/g, " ").toLowerCase();
      reasonCounts.set(k, (reasonCounts.get(k) || 0) + 1);
    }
    const authFails = negEvents.filter((e) => ["2", "15", "23"].includes(String(e.reason)) || /4-way|handshake|auth.*fail/i.test(`${e.type} ${e.text}`));

    const sess = results(sessions).map((s) => ({
      ap: ((m) => (findAp(m) ? hex(findAp(m).mac) : hex(m)))(pick(s.ap, s.ap_mac, s.bssid)), band: bandGroup(s.band), ssid: String(pick(s.ssid) || ""),
      start: epoch(s.connect), end: epoch(s.disconnect), dur: num(s.duration),
    })).filter((s) => s.start).sort((a, b) => a.start - b.start);
    let pingPong = 0;
    for (let i = 2; i < sess.length; i++) {
      if (sess[i].ap === sess[i - 2].ap && sess[i].ap !== sess[i - 1].ap && sess[i].start - sess[i - 2].start <= 300) pingPong += 1;
    }
    const roams = sess.filter((s, i) => i > 0 && s.ap !== sess[i - 1].ap).length;
    const shortSess = sess.filter((s) => (s.dur ?? ((s.end || now) - s.start)) < 60).length;
    const spanH = sess.length ? Math.max(1, ((sess.at(-1).end || now) - sess[0].start) / 3600) : 1;
    const bandsUsed = new Set(sess.map((s) => s.band).filter((b) => b !== "unk"));

    const rssiPts = series.filter((s) => family(s.name) === "rssi").flatMap((s) => s.pts.map((p) => p[1]));
    const weakShare = rssiPts.length ? pct(rssiPts.filter((v) => v < THRESHOLDS.rssi.cuts[1]).length, rssiPts.length) : null;

    // ---- 5. Findings ------------------------------------------------------------
    const findings = [];
    const add = (sev, facet, title, evidence, advice) => findings.push({ sev, facet, title, evidence, advice });
    const lastKnown = live ? "" : " (last known; client is not connected now)";

    const gR = grade(rssi, THRESHOLDS.rssi);
    if (gR === "unknown") add("unknown", "Signal", "No RSSI reported", "Mist returned no RSSI for this client.", "");
    else add(gR, "Signal", gR === "good" ? "Strong signal" : gR === "warning" ? "Signal below the -65 dBm comfort zone" : gR === "serious" ? "Weak signal for voice and video" : "Coverage hole: signal below -75 dBm",
      `RSSI ${rssi} dBm${lastKnown}.`,
      gR === "good" ? "" : "Below -67 dBm real-time media starts to suffer; below -75 dBm expect retries, low MCS and sticky-client behaviour. Check AP placement and power, and whether the client is holding on to a distant AP.");
    if (weakShare != null && weakShare >= 20 && RANK[gR] >= RANK.warning) {
      add(weakShare >= 50 ? "serious" : "warning", "Signal", "Signal is often weak over the period",
        `${round(weakShare, 0)}% of RSSI samples were below ${THRESHOLDS.rssi.cuts[1]} dBm even though the current value is ${rssi ?? "unknown"} dBm.`,
        "Intermittent weak signal points at movement through a coverage gap or a client that roams late.");
    }

    const gS = grade(snr, THRESHOLDS.snr);
    if (gS !== "unknown") {
      const interference = RANK[gR] >= RANK.warning && RANK[gS] <= RANK.serious;
      add(gS, "SNR", gS === "good" ? "Clean signal-to-noise" : interference ? "Interference: SNR is low while RSSI is usable" : "Low signal-to-noise ratio",
        `SNR ${snr} dB with RSSI ${rssi ?? "?"} dBm${noise != null ? ` and a ${noise} dBm noise floor` : ""}${lastKnown}.`,
        gS === "good" ? "" : interference
          ? "Distance is not the problem. Look for co-channel APs, non-Wi-Fi sources (see channel utilisation) or a noisy channel, and consider a channel change."
          : "Below 25 dB higher MCS rates become unreachable; below 15 dB expect packet loss.");
    }

    const gN = grade(noise, THRESHOLDS.noise);
    if (gN !== "unknown") add(gN, "Noise floor", gN === "good" ? "Quiet channel" : "Raised noise floor on the serving radio",
      `Noise floor ${noise} dBm on ${BAND[band].label} channel ${channel ?? "?"} of ${servingAp?.name || "the serving AP"}.`,
      gN === "good" ? "" : "Every dB of noise above about -90 dBm is a dB of SNR lost. Hunt for non-Wi-Fi interferers (microwaves, wireless video, Bluetooth) or move channel.");

    const gE = grade(eff, THRESHOLDS.eff);
    if (gE !== "unknown") add(gE, "PHY rate", gE === "good" ? "PHY rate near its ceiling" : "PHY rate far below what the link could do",
      `Best rate ${round(bestRate, 0)} Mbps of a ${round(ceiling, 0)} Mbps ceiling (${round(eff, 0)}%) for ${GENERATION[proto]?.label || proto}, ${widthLabel}, ${streams} stream(s)${streamsKnown ? "" : " assumed"}.`,
      gE === "good" ? "" : "Low MCS follows low SNR, retries or a client that is power-saving or idle. If SNR is good, check retries and channel utilisation.");

    const gT = grade(retryPct >= 0 ? retryPct : null, THRESHOLDS.retry);
    if (gT !== "unknown") add(gT, "Retries", gT === "good" ? "Few retransmissions" : "High retransmission rate",
      `${round(retryPct, 1)}% of frames were retries (tx ${round(txRetryPct, 1) ?? "?"}%, rx ${round(rxRetryPct, 1) ?? "?"}%).`,
      gT === "good" ? "" : "Retries above about 10% waste airtime and add latency. Common causes: low SNR, hidden nodes, co-channel contention, or an overly aggressive rate.");

    const gU = grade(util.all, THRESHOLDS.util);
    if (gU !== "unknown") add(gU, "Channel load", gU === "good" ? "Channel has airtime to spare" : "Busy channel",
      `${util.all}% channel utilisation on the serving radio (tx ${util.tx ?? "?"}%, rx in-BSS ${util.inBss ?? "?"}%, other BSS ${util.otherBss ?? "?"}%, non-Wi-Fi ${util.nonWifi ?? "?"}%).`,
      gU === "good" ? "" : "Above about 50% busy, contention and latency rise quickly. Split load across channels, narrow the channel width, or remove low-rate legacy clients.");

    const gW = grade(util.nonWifi, THRESHOLDS.nonwifi);
    if (gW !== "unknown" && gW !== "good") add(gW, "Interference", "Non-Wi-Fi energy on the channel",
      `${util.nonWifi}% of airtime is non-Wi-Fi energy.`,
      "Something that is not Wi-Fi is transmitting on this channel. Check for microwave ovens, cordless phones, wireless cameras or Bluetooth, especially on 2.4 GHz.");

    if (servingOcc) {
      const gC = grade(coChannel.length, THRESHOLDS.cochannel);
      const s = servingOcc;
      add(gC, "Co-channel", gC === "good" ? "Little co-channel overlap at this site" : "Many APs overlap the serving channel",
        `The serving radio is on ${BAND[band].label} channel ${s.ch} at ${s.width} MHz (channels ${s.span[0]}–${s.span[1]}). ` +
        `${coChannel.length} other AP radio(s) at this site overlap it, ${samePrimary} on the same primary channel` +
        `${coChannel.length ? `: ${coChannel.slice(0, 6).map((o) => `${o.name} (ch ${o.ch}/${o.width})`).join(", ")}${coChannel.length > 6 ? "…" : ""}` : ""}.`,
        gC === "good" ? "" : "Overlapping radios that hear each other share airtime, and wide channels overlap more neighbours. " +
          "Review the RRM channel plan, consider narrower channels, and check transmit power.");
    }
    if (radioClients != null) {
      const gL = grade(radioClients, THRESHOLDS.load);
      if (gL !== "good") add(gL, "Radio load", "Crowded serving radio", `${radioClients} clients on the serving ${BAND[band].label} radio.`,
        "Heavy client counts on one radio mean less airtime each. Check band steering and neighbouring AP coverage.");
    }

    if (band === "24") {
      const dual = c.dual_band === true || bandsUsed.has("5") || bandsUsed.has("6");
      add(dual ? "serious" : "warning", "Band", "Connected on 2.4 GHz",
        `The client is on 2.4 GHz${dual ? " although it has used 5/6 GHz in this period" : ""}.`,
        "2.4 GHz has three usable channels, more interference and lower rates. Enable band steering or raise the 2.4 GHz minimum RSSI so capable clients prefer 5 or 6 GHz.");
      if (width && width > 20) add("serious", "Band", "40 MHz channel on 2.4 GHz", `The serving 2.4 GHz radio uses ${width} MHz.`,
        "40 MHz on 2.4 GHz overlaps two of the three non-overlapping channels. Use 20 MHz.");
    } else if (band !== "unk") {
      add("good", "Band", `Connected on ${BAND[band].label}`, `${BAND[band].label}, channel ${channel ?? "?"}, ${widthLabel}.`, "");
    }

    if (proto) {
      const g = GENERATION[proto];
      add(g.sev, "Wi-Fi generation", g.sev === "good" ? g.label : `Older PHY: ${g.label}`, `Negotiated protocol ${g.label}.`,
        g.sev === "good" ? "" : "Older PHYs cap the rate and take more airtime per byte, slowing the whole cell. Check the client driver, or whether the SSID/radio allows newer modes.");
    }

    if (sess.length) {
      const gP = pingPong >= 4 ? "serious" : pingPong >= 1 ? "warning" : "good";
      add(gP, "Roaming", pingPong ? "Ping-pong roaming" : `${roams} roam(s) across ${new Set(sess.map((s) => s.ap)).size} AP(s)`,
        `${sess.length} session(s), ${roams} roam(s) (${round(roams / spanH, 1)}/hour), ${pingPong} A→B→A bounce(s) within 5 minutes, ${shortSess} session(s) under a minute.`,
        pingPong ? "Bouncing between two APs means overlapping cells of similar strength. Reduce power on one AP or tune roaming thresholds." : "");
    }
    if (evs.length) {
      const n = negEvents.length;
      const gD = n > 30 ? "critical" : n > 10 ? "serious" : n > 3 ? "warning" : "good";
      const top = [...reasonCounts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ×${v}`).join(", ");
      add(gD, "Disconnects", n ? `${n} disconnect or failure event(s)` : "No disconnects or failures",
        `${evs.length} event(s) in the period, ${n} negative${top ? `. Most common: ${top}` : ""}.`,
        n ? "Reason 4 (inactivity) with weak RSSI suggests a sticky client; reasons 3 and 8 are the client leaving; 2, 15 and 23 are authentication failures." : "");
      if (authFails.length) add(authFails.length > 5 ? "serious" : "warning", "Disconnects", "Authentication or 4-way handshake failures",
        `${authFails.length} failure(s) with reason 2, 15 or 23, or a handshake timeout.`,
        "Usually a PSK mismatch, an expired 802.1X credential, or key exchange lost to poor RF. If RF is clean, check the RADIUS logs.");
    }
    findings.sort((a, b) => RANK[a.sev] - RANK[b.sev]);
    const overall = worst(findings.map((f) => f.sev).filter((s) => s !== "unknown"));
    const issues = findings.filter((f) => RANK[f.sev] <= RANK.warning);

    // ---- 6. Dashboard -----------------------------------------------------------
    const identity = {
      mac: formatMac(mac),
      hostname: pick(c.hostname, last.hostname, last.last_hostname) || "",
      username: pick(c.username, last.username, last.last_username) || "",
      ip: pick(c.ip, last.ip, last.last_ip) || "",
      device: [pick(c.manufacture, last.mfg, last.manufacture), pick(c.os, last.os, last.last_os), pick(c.model, last.model, last.last_model)].filter(Boolean).join(" · "),
      ssid: pick(c.ssid, last.ssid, last.last_ssid) || "",
      ap: servingAp?.name || (apMac ? formatMac(apMac) : ""),
      site: siteName(siteId),
      live: !!live,
      lastSeen: epoch(pick(c.last_seen, last.last_seen, last.timestamp)),
    };
    const tiles = [
      { label: "RSSI", value: rssi, unit: "dBm", t: THRESHOLDS.rssi, sev: gR },
      { label: "SNR", value: snr, unit: "dB", t: THRESHOLDS.snr, sev: gS },
      { label: "Noise floor", value: noise, unit: "dBm", t: THRESHOLDS.noise, sev: gN },
      { label: "PHY rate vs ceiling", value: eff == null ? null : round(eff, 0), unit: "%", t: THRESHOLDS.eff, sev: gE,
        note: bestRate ? `${round(bestRate, 0)} / ${round(ceiling, 0)} Mbps` : "" },
      { label: "Retries", value: retryPct >= 0 ? round(retryPct, 1) : null, unit: "%", t: THRESHOLDS.retry, sev: gT },
      { label: "Channel utilisation", value: util.all, unit: "%", t: THRESHOLDS.util, sev: gU },
      { label: "Non-Wi-Fi airtime", value: util.nonWifi, unit: "%", t: THRESHOLDS.nonwifi, sev: grade(util.nonWifi, THRESHOLDS.nonwifi) },
      { label: "Overlapping AP radios", value: servingOcc ? coChannel.length : null, unit: "", t: THRESHOLDS.cochannel,
        sev: servingOcc ? grade(coChannel.length, THRESHOLDS.cochannel) : "unknown",
        note: servingOcc ? `ch ${servingOcc.ch} · ${servingOcc.width} MHz · ${samePrimary} same primary` : "" },
    ];
    const facts = [
      ["Band", BAND[band].label, band === "24" ? "serious" : band === "unk" ? "unknown" : "good"],
      ["Channel", channel != null ? `${channel} · ${widthLabel}` : "", channel != null ? "good" : "unknown"],
      ["Generation", GENERATION[proto]?.label || "", GENERATION[proto]?.sev || "unknown"],
      ["Spatial streams", streamsKnown ? String(streamsKnown) : `${ASSUMED_STREAMS} (assumed)`, streamsKnown ? "good" : "unknown"],
      ["AP transmit power", radio?.power != null ? `${radio.power} dBm` : "", radio?.power != null ? "good" : "unknown"],
      ["Clients on radio", radioClients != null ? String(radioClients) : "", radioClients != null ? grade(radioClients, THRESHOLDS.load) : "unknown"],
    ];
    if (ctx.mount) {
      drawDashboard(ctx, {
        identity, overall, issues, findings, tiles, facts, series, util, band, channel, occ, servingOcc,
        sess, evs, negEvents, reasonCounts, apName, t0: now - durS, t1: now, duration,
      });
    }
    ctx.progress(3, 3, "Done");

    // ---- 7. Workbook --------------------------------------------------------------
    const fmtT = (t) => (t ? ctx.fmtTime(t) : "");
    const findingRows = findings.map((f) => ({ ...f, sev: STATUS[f.sev].label,
      __style: f.sev === "critical" ? "red" : f.sev === "serious" || f.sev === "warning" ? "yellow" : f.sev === "good" ? "green" : undefined }));
    const phyRows = [
      ["Client MAC", identity.mac], ["Hostname", identity.hostname], ["Username", identity.username], ["IP", identity.ip],
      ["Device", identity.device], ["Site", identity.site], ["SSID", identity.ssid], ["AP", identity.ap],
      ["Connected now", live ? "Yes" : "No"], ["Last seen", fmtT(identity.lastSeen)],
      ["Band", BAND[band].label], ["Channel", channel ?? ""], ["Channel width (MHz)", widthInferred ? `${width} (inferred from rate)` : width],
      ["Protocol", GENERATION[proto]?.label || ""], ["Spatial streams", streamsKnown ?? `${ASSUMED_STREAMS} (assumed)`],
      ["RSSI (dBm)", rssi ?? ""], ["SNR (dB)", snr ?? ""], ["Noise floor (dBm)", noise ?? ""],
      ["TX rate (Mbps)", txRate ?? ""], ["RX rate (Mbps)", rxRate ?? ""], ["PHY ceiling (Mbps)", round(ceiling, 1) ?? ""],
      ["Rate efficiency (%)", round(eff, 1) ?? ""], ["TX retries", txRetries ?? ""], ["RX retries", rxRetries ?? ""],
      ["TX packets", txPkts ?? ""], ["RX packets", rxPkts ?? ""], ["Retry rate (%)", retryPct >= 0 ? round(retryPct, 1) : ""],
      ["Channel utilisation (%)", util.all ?? ""], ["  Transmit (%)", util.tx ?? ""], ["  Receive in-BSS (%)", util.inBss ?? ""],
      ["  Receive other BSS (%)", util.otherBss ?? ""], ["  Unknown Wi-Fi (%)", util.unknownWifi ?? ""], ["  Non-Wi-Fi (%)", util.nonWifi ?? ""],
      ["AP transmit power (dBm)", radio?.power ?? ""], ["Clients on radio", radioClients ?? ""],
      ["Overlapping AP radios at site", servingOcc ? coChannel.length : ""],
      ["  Same primary channel", servingOcc ? samePrimary : ""],
    ];
    const tsRows = series.flatMap((s) => s.pts.map(([t, v]) => ({ metric: s.name, time: fmtT(t), value: v })));
    const sessRows = sess.map((s) => ({ ap: apName(s.ap), band: BAND[s.band].label, ssid: s.ssid, start: fmtT(s.start),
      end: fmtT(s.end), dur: s.dur ?? (s.end ? round(s.end - s.start, 0) : "") }));
    const evRowsOut = [...evs].reverse().map((e) => ({ time: fmtT(e.t), type: e.type, text: e.text, ap: apName(e.ap),
      band: BAND[e.band].label, channel: e.channel, reason: e.reasonText, negative: e.negative ? "Yes" : "",
      __style: e.negative ? "red" : undefined }));
    const relation = (o) => (o.serving ? "Serving" : servingOcc && overlaps(o.span, servingOcc.span) ? "Overlaps serving" : "Clear");
    const chRows = [...occ].sort((a, b) => a.span[0] - b.span[0] || a.ch - b.ch || a.name.localeCompare(b.name)).map((o) => ({
      ap: o.name, ch: o.ch, width: o.width, span: `${o.span[0]}–${o.span[1]}`, clients: o.clients ?? "", util: o.util ?? "",
      rel: relation(o), __style: o.serving ? "blue" : relation(o) === "Clear" ? undefined : "yellow" }));
    const info = [
      ["Org", ctx.orgName], ["Site", identity.site], ["Client", identity.mac], ["Look back", duration],
      ["Overall", STATUS[overall].label], ["Insight metrics tried", metrics.join(", ")],
      ["RSSI grading (dBm)", ">= -65 good, -65..-70 warning, -70..-75 serious, < -75 critical"],
      ["SNR grading (dB)", ">= 25 good, 20..25 warning, 15..20 serious, < 15 critical"],
      ["Noise floor grading (dBm)", "<= -90 good, -90..-85 warning, -85..-80 serious, > -80 critical"],
      ["Retry grading (%)", "<= 10 good, 10..20 warning, 20..30 serious, > 30 critical"],
      ["Channel utilisation grading (%)", "<= 50 good, 50..70 warning, 70..85 serious, > 85 critical"],
      ["PHY ceiling", "Top MCS for the generation and channel width times spatial streams (2 assumed when Mist does not report it)"],
      ["Generated", ctx.epochToUtc(Date.now())],
    ];
    const sheets = [
      ctx.xlsx.sheet("Findings", [
        { header: "Severity", key: "sev", width: 10 }, { header: "Facet", key: "facet", width: 16 },
        { header: "Finding", key: "title", width: 40 }, { header: "Evidence", key: "evidence", width: 70, wrap: true },
        { header: "What to check", key: "advice", width: 70, wrap: true },
      ], findingRows, { tabColor: "C00000" }),
      ctx.xlsx.sheet("PHY Snapshot", [{ header: "Field", width: 26 }, { header: "Value", width: 40 }], phyRows,
        { autofilter: false, tabColor: "1F4E78" }),
      ctx.xlsx.sheet("Time Series", [{ header: "Metric", key: "metric", width: 24 }, { header: "Time", key: "time", width: 20 },
        { header: "Value", key: "value", width: 14 }], tsRows, { tabColor: "548235" }),
      ctx.xlsx.sheet("Sessions", [{ header: "AP", key: "ap", width: 24 }, { header: "Band", key: "band", width: 10 },
        { header: "SSID", key: "ssid", width: 20 }, { header: "Connected", key: "start", width: 20 },
        { header: "Disconnected", key: "end", width: 20 }, { header: "Duration (s)", key: "dur", width: 12 }], sessRows, { tabColor: "7030A0" }),
      ctx.xlsx.sheet("Events", [{ header: "Time", key: "time", width: 20 }, { header: "Type", key: "type", width: 30 },
        { header: "Text", key: "text", width: 40, wrap: true }, { header: "AP", key: "ap", width: 22 },
        { header: "Band", key: "band", width: 10 }, { header: "Channel", key: "channel", width: 8 },
        { header: "802.11 Reason", key: "reason", width: 40 }, { header: "Negative", key: "negative", width: 9 }], evRowsOut, { tabColor: "C55A11" }),
      ctx.xlsx.sheet("Channel Map", [{ header: "AP", key: "ap", width: 26 },
        { header: `${BAND[band].label} primary channel`, key: "ch", width: 12 }, { header: "Width (MHz)", key: "width", width: 10 },
        { header: "Occupies channels", key: "span", width: 14 }, { header: "Clients", key: "clients", width: 8 },
        { header: "Utilisation (%)", key: "util", width: 12 }, { header: "Relation to serving radio", key: "rel", width: 22 }],
        chRows, { tabColor: "2E75B6" }),
      ctx.xlsx.sheet("Info", [{ header: "Field" }, { header: "Value", wrap: true }], info, { autofilter: false, freeze: null }),
    ];

    return {
      summary: `${identity.hostname || identity.mac} at ${identity.site}: ${STATUS[overall].label}. ` +
        `${issues.length} issue(s) across ${findings.length} check(s)${live ? "" : " (client offline, last-known values)"}`,
      filename: ctx.stampedName(`mist_client_phy_${mac}`, ctx.orgName, "xlsx"),
      sheets,
    };
  },
};

function formatMac(m) {
  const h = String(m || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  return h.length === 12 ? h.match(/../g).join(":") : String(m || "");
}

// ---------------------------------------------------------------------------
// Dashboard. Dark-surface steps of the reference palette: status colours for
// grades (always with icon + label), categorical slots for bands and series.

function drawDashboard(ctx, d) {
  const E = ctx.esc;
  const W = 760;
  const charts = new Map();
  let chartSeq = 0;
  const fmtShort = (t) => {
    const dt = new Date(t * 1000);
    return d.duration === "7d"
      ? dt.toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  };
  const fmtVal = (v, unit) => {
    if (v == null) return "–";
    if (unit === "bps") return v >= 1e6 ? `${round(v / 1e6, 1)} Mbps` : v >= 1e3 ? `${round(v / 1e3, 1)} kbps` : `${round(v, 0)} bps`;
    if (unit === "bytes") return ctx.fmtBytes(v);
    return `${round(v, 1)}${unit ? ` ${unit}` : ""}`;
  };
  const badge = (sev, text) => `<span class="phy-badge" style="--c:${STATUS[sev].color}">` +
    `<b>${STATUS[sev].icon}</b>${E(text ?? STATUS[sev].label)}</span>`;

  // Bullet meter: threshold zones, a marker at the value.
  const meter = (tile) => {
    const t = tile.t;
    const span = t.max - t.min;
    const zs = zones(t).map((z) => `<i style="width:${((z.to - z.from) / span) * 100}%;background:${STATUS[z.sev].color}"></i>`).join("");
    const v = tile.value == null ? null : Math.min(t.max, Math.max(t.min, tile.value));
    const pos = v == null ? null : ((v - t.min) / span) * 100;
    return `<div class="phy-meter">${zs}${pos == null ? "" : `<s style="left:${pos}%"></s>`}</div>` +
      `<div class="phy-scale"><span>${t.min}</span><span>${t.max} ${E(t.unit)}</span></div>`;
  };

  // Line chart with threshold zones, failure markers, crosshair tooltip.
  const lineChart = ({ title, unit, lines, t, markers = [] }) => {
    const id = `phyc${++chartSeq}`;
    const H = 210, L = 52, R = 14, T = 12, B = 26;
    const all = lines.flatMap((l) => l.pts.map((p) => p[1]));
    let lo = t ? t.min : Math.min(...all);
    let hi = t ? t.max : Math.max(...all);
    if (t) { lo = Math.min(lo, ...all); hi = Math.max(hi, ...all); }
    if (!t) { if (lo >= 0) lo = 0; const padY = (hi - lo) * 0.08 || 1; hi += padY; }
    const sx = (x) => L + ((x - d.t0) / (d.t1 - d.t0)) * (W - L - R);
    const sy = (y) => T + (1 - (y - lo) / (hi - lo || 1)) * (H - T - B);
    const zoneRects = t ? zones(t).map((z) => {
      const y1 = sy(Math.min(hi, z.to)); const y2 = sy(Math.max(lo, z.from));
      return y2 > y1 ? `<rect x="${L}" y="${y1}" width="${W - L - R}" height="${y2 - y1}" fill="${STATUS[z.sev].color}" opacity="0.11"/>` : "";
    }).join("") : "";
    const ticks = niceTicks(lo, hi);
    const grid = ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}" class="g"/>` +
      `<text x="${L - 6}" y="${sy(v) + 4}" text-anchor="end">${E(fmtVal(v, unit === "bps" || unit === "bytes" ? unit : ""))}</text>`).join("");
    const xt = Array.from({ length: 5 }, (_, i) => d.t0 + ((d.t1 - d.t0) * i) / 4)
      .map((x, i) => `<text x="${sx(x)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === 4 ? "end" : "middle"}">${E(fmtShort(x))}</text>`).join("");
    const paths = lines.map((l) => {
      const pts = l.pts.filter((p) => p[0] >= d.t0 - 60);
      const dpath = pts.map((p, i) => `${i ? "L" : "M"}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join("");
      const dots = pts.length <= 48 ? pts.map((p) => `<circle cx="${sx(p[0]).toFixed(1)}" cy="${sy(p[1]).toFixed(1)}" r="3" fill="${l.color}" stroke="var(--phy-surface)" stroke-width="2"/>`).join("") : "";
      return `<path d="${dpath}" fill="none" stroke="${l.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
    }).join("");
    const marks = markers.filter((m) => m.t >= d.t0).map((m) =>
      `<line x1="${sx(m.t)}" x2="${sx(m.t)}" y1="${T}" y2="${H - B}" stroke="${STATUS.critical.color}" stroke-width="1" opacity="0.55" stroke-dasharray="2 3"/>`).join("");
    charts.set(id, { lines, sx, sy, unit, L, R, T, B, H, markers });
    const legend = lines.length > 1 ? `<div class="phy-legend">${lines.map((l) =>
      `<span><i style="background:${l.color}"></i>${E(l.name)}</span>`).join("")}</div>` : "";
    return `<figure class="phy-chart"><figcaption>${E(title)}${lines.length === 1 ? ` <em>${E(lines[0].name)}</em>` : ""}</figcaption>${legend}
      <div class="phy-svgwrap" data-chart="${id}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${E(title)}">
      ${zoneRects}${grid}<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" class="a"/>${xt}${marks}${paths}
      <line class="x" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/></svg></div>
      ${markers.length ? `<div class="phy-note"><span class="phy-dash"></span>Dashed red lines: disconnect / failure events</div>` : ""}</figure>`;
  };

  // ---- Sections ----------------------------------------------------------------
  const id = d.identity;
  const counts = ["critical", "serious", "warning", "good"].map((s) => [s, d.findings.filter((f) => f.sev === s).length]).filter(([, n]) => n);
  const header = `<section class="phy-head" style="--c:${STATUS[d.overall].color}">
    <div><div class="phy-kicker">Wi-Fi PHY health</div><div class="phy-verdict">${badge(d.overall, STATUS[d.overall].label)}</div>
      <div class="phy-counts">${counts.map(([s, n]) => badge(s, `${n} ${STATUS[s].label.toLowerCase()}`)).join("")}</div></div>
    <dl>${[["Client", `${id.hostname ? `${id.hostname} · ` : ""}${id.mac}`], ["Device", id.device], ["Site", id.site],
      ["SSID / AP", [id.ssid, id.ap].filter(Boolean).join(" · ")], ["IP / user", [id.ip, id.username].filter(Boolean).join(" · ")],
      ["State", id.live ? "Connected now" : `Offline · last seen ${id.lastSeen ? ctx.fmtTime(id.lastSeen) : "?"}`]]
      .filter(([, v]) => v).map(([k, v]) => `<dt>${E(k)}</dt><dd>${E(v)}</dd>`).join("")}</dl></section>`;

  const tiles = `<section><h3>Scorecard</h3><div class="phy-tiles">${d.tiles.map((t) =>
    `<div class="phy-tile" style="--c:${STATUS[t.sev].color}" data-tip="${E(`${t.label}: ${fmtVal(t.value, t.unit)} — ${STATUS[t.sev].label}`)}">
      <div class="phy-tl">${E(t.label)}</div><div class="phy-tv">${E(t.value == null ? "–" : `${t.value}`)}<small>${E(t.value == null ? "" : t.unit)}</small></div>
      ${badge(t.sev)}${t.note ? `<div class="phy-tn">${E(t.note)}</div>` : ""}${meter(t)}</div>`).join("")}</div>
    <div class="phy-facts">${d.facts.map(([k, v, s]) => `<div style="--c:${STATUS[s].color}"><span>${E(k)}</span><b>${E(v || "–")}</b></div>`).join("")}</div></section>`;

  const findingsHtml = `<section><h3>Findings</h3>${d.issues.length ? "" : `<p class="phy-muted">No issues found. Every graded facet is healthy.</p>`}
    <div class="phy-findings">${d.findings.filter((f) => f.sev !== "good" && f.sev !== "unknown").map((f) =>
      `<div class="phy-f" style="--c:${STATUS[f.sev].color}">${badge(f.sev)}<div><b>${E(f.title)}</b> <span class="phy-facet">${E(f.facet)}</span>
      <p>${E(f.evidence)}</p>${f.advice ? `<p class="phy-adv">${E(f.advice)}</p>` : ""}</div></div>`).join("")}</div>
    ${d.findings.some((f) => f.sev === "good") ? `<details><summary>Healthy checks (${d.findings.filter((f) => f.sev === "good").length})</summary>
      <ul>${d.findings.filter((f) => f.sev === "good").map((f) => `<li>${badge("good", f.facet)} ${E(f.title)}: ${E(f.evidence)}</li>`).join("")}</ul></details>` : ""}</section>`;

  // Time series grouped by family; tx/rx share a chart, never two y-axes.
  const groups = new Map();
  for (const s of d.series) groups.set(family(s.name), [...(groups.get(family(s.name)) || []), s]);
  const famOrder = [...groups.keys()].sort((a, b) => (FAMILY_ORDER.indexOf(a) + 1 || 99) - (FAMILY_ORDER.indexOf(b) + 1 || 99));
  const markers = d.negEvents.map((e) => ({ t: e.t, label: e.reasonText || e.type }));
  const tsHtml = famOrder.length
    ? `<section><h3>Over time</h3><div class="phy-charts">${famOrder.map((f) => {
      const meta = FAMILY_META[f] || { title: f.replace(/_/g, " "), unit: "" };
      const lines = groups.get(f).slice(0, 8).map((s, i) => ({ name: s.name, pts: s.pts, color: SERIES[i] }));
      return lineChart({ title: meta.title, unit: meta.unit, lines, t: meta.t, markers: ["rssi", "snr"].includes(f) ? markers : [] });
    }).join("")}</div></section>`
    : `<section><h3>Over time</h3><p class="phy-muted">Mist returned no time series for this client. The scorecard uses live or last-known values.</p></section>`;

  // Airtime breakdown of the serving radio.
  const u = d.util;
  const parts = [
    ["Transmit", u.tx, SERIES[0]], ["Receive, other BSS", u.otherBss, SERIES[1]], ["Receive, this BSS", u.inBss, SERIES[2]],
    ["Unknown Wi-Fi", u.unknownWifi, SERIES[3]], ["Non-Wi-Fi", u.nonWifi, SERIES[4]],
  ].filter(([, v]) => v != null && v > 0);
  const used = parts.reduce((s, [, v]) => s + v, 0);
  const airtime = u.all == null && !parts.length ? "" : `<figure class="phy-chart"><figcaption>Serving radio airtime
      <em>${E(BAND[d.band].label)} ch ${E(d.channel ?? "?")} · ${E(u.all ?? round(used, 0))}% busy</em></figcaption>
    <div class="phy-stack">${parts.map(([k, v, col]) => `<i style="width:${v}%;background:${col}" data-tip="${E(`${k}: ${v}%`)}"></i>`).join("")}
      <i class="idle" style="width:${Math.max(0, 100 - Math.max(used, u.all || 0))}%" data-tip="Idle"></i></div>
    <div class="phy-legend">${parts.map(([k, v, col]) => `<span><i style="background:${col}"></i>${E(k)} <b>${E(v)}%</b></span>`).join("")}
      <span><i class="idle"></i>Idle</span></div></figure>`;

  // Channel occupancy: the band's whole 20 MHz channel plan on the x-axis, every AP
  // radio as a bar across the channels it occupies (width included), packed into
  // rows. Serving radio blue; radios overlapping it flagged; DFS range shaded.
  const plan = channelPlan(d.band, d.occ);
  const chanHtml = d.occ.length && plan.length ? (() => {
    const L = 8, R = 8, top = 26, RH = 22, MAXROWS = 24;
    const cw = (W - L - R) / plan.length;
    const col = (ch) => { const i = plan.findIndex((p) => p >= ch); return i < 0 ? plan.length - 1 : i; };
    const so = d.servingOcc;
    const rel = (o) => (o.serving ? "serving" : so && overlaps(o.span, so.span) ? "overlap" : "clear");
    const STYLE = {
      serving: { fill: SERIES[0], ink: "#ffffff" },
      overlap: { fill: STATUS.serious.color, ink: "#0b0d11" },
      clear: { fill: "var(--phy-neutral)", ink: "var(--phy-fg)" },
    };
    const order = { serving: 0, overlap: 1, clear: 2 };
    const items = [...d.occ].sort((a, b) => order[rel(a)] - order[rel(b)] || a.span[0] - b.span[0] || a.name.localeCompare(b.name));
    const rows = [];
    let hidden = 0;
    const placed = [];
    for (const o of items) {
      const i0 = col(o.span[0]); const i1 = Math.max(i0, col(o.span[1]));
      let r = rows.findIndex((row) => row.every(([a, b]) => i1 < a || i0 > b));
      if (r < 0) { if (rows.length >= MAXROWS) { hidden += 1; continue; } rows.push([]); r = rows.length - 1; }
      rows[r].push([i0, i1]);
      placed.push({ o, i0, i1, r });
    }
    const plotH = rows.length * RH;
    const H = top + plotH + 44;
    const cover = plan.map((ch) => d.occ.filter((o) => ch >= o.span[0] && ch <= o.span[1]).length);
    const step = Math.max(1, Math.ceil(26 / cw));
    const inServing = (ch) => so && ch >= so.span[0] && ch <= so.span[1];
    const dfs = d.band === "5" ? [col(DFS_5[0]), col(DFS_5[1])] : null;
    const tipFor = (o) => `${o.name}${o.serving ? " (serving)" : ""}\nPrimary channel ${o.ch} · ${o.width} MHz` +
      `\nOccupies ${o.span[0] === o.span[1] ? `channel ${o.span[0]}` : `channels ${o.span[0]}–${o.span[1]}`}` +
      `${o.clients != null ? `\n${o.clients} client(s)` : ""}${o.util != null ? ` · ${o.util}% busy` : ""}` +
      `${rel(o) === "overlap" ? `\n▲ Shares airtime with the serving radio` : ""}`;
    const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${E(`${BAND[d.band].label} channel occupancy`)}">
      ${dfs ? `<rect x="${L + dfs[0] * cw}" y="${top - 18}" width="${(dfs[1] - dfs[0] + 1) * cw}" height="${plotH + 18}" fill="var(--phy-fg)" opacity="0.04"/>
        <text x="${L + dfs[0] * cw + 4}" y="${top - 6}">DFS</text>` : ""}
      ${so ? `<rect x="${L + col(so.span[0]) * cw}" y="${top - 18}" width="${(col(so.span[1]) - col(so.span[0]) + 1) * cw}" height="${plotH + 18}"
        fill="${SERIES[0]}" opacity="0.10"/><text x="${L + (col(so.span[0]) + col(so.span[1]) + 1) * cw / 2}" y="${top - 6}" text-anchor="middle"
        style="fill:var(--phy-fg);font-weight:600">serving</text>` : ""}
      ${plan.map((_, i) => `<line x1="${L + i * cw}" x2="${L + i * cw}" y1="${top}" y2="${top + plotH}" class="g"/>`).join("")}
      <line x1="${L + plan.length * cw}" x2="${L + plan.length * cw}" y1="${top}" y2="${top + plotH}" class="g"/>
      ${placed.map(({ o, i0, i1, r }) => {
        const x = L + i0 * cw + 2; const w = (i1 - i0 + 1) * cw - 4; const y = top + r * RH + 3; const s = STYLE[rel(o)];
        const chars = Math.floor((w - 10) / 6.4);
        const label = chars >= 4 ? (o.name.length > chars ? `${o.name.slice(0, chars - 1)}…` : o.name) : "";
        return `<g data-tip="${E(tipFor(o))}"><rect x="${x}" y="${y}" width="${Math.max(3, w)}" height="${RH - 6}" rx="4" fill="${s.fill}"
          ${o.serving ? `stroke="var(--phy-fg)" stroke-width="1.5"` : ""}/>${label ? `<text x="${x + 6}" y="${y + RH / 2 + 1}"
          style="fill:${s.ink};font-size:10.5px;font-weight:${o.serving ? 700 : 500}">${E(label)}</text>` : ""}</g>`;
      }).join("")}
      <line x1="${L}" x2="${W - R}" y1="${top + plotH}" y2="${top + plotH}" class="a"/>
      ${plan.map((ch, i) => (i % step && !inServing(ch) ? "" : `<text x="${L + (i + 0.5) * cw}" y="${top + plotH + 15}" text-anchor="middle"
        ${inServing(ch) ? `style="fill:var(--phy-fg);font-weight:700"` : ""}>${ch}</text>`)).join("")}
      ${plan.map((ch, i) => `<text x="${L + (i + 0.5) * cw}" y="${top + plotH + 32}" text-anchor="middle"
        style="font-size:10px;${cover[i] ? `fill:var(--phy-fg)` : ""}" data-tip="${E(`Channel ${ch}: ${cover[i]} AP radio(s) occupy it`)}">${cover[i] || "·"}</text>`).join("")}
    </svg>`;
    const nOver = d.occ.filter((o) => rel(o) === "overlap").length;
    return `<figure class="phy-chart"><figcaption>${E(BAND[d.band].label)} channel occupancy at this site
        <em>${so ? `serving ch ${E(so.ch)} · ${E(so.width)} MHz (${E(so.span[0])}–${E(so.span[1])}) · ${E(nOver)} overlapping radio(s)` : "serving radio unknown"}</em></figcaption>
      <div class="phy-legend"><span><i style="background:${SERIES[0]}"></i>Serving AP radio</span>
        <span><i style="background:${STATUS.serious.color}"></i>${STATUS.serious.icon} Overlaps the serving channel</span>
        <span><i style="background:var(--phy-neutral)"></i>Other AP radios</span>
        ${dfs ? `<span><i style="background:var(--phy-fg);opacity:.15"></i>DFS channels</span>` : ""}</div>
      ${svg}
      <div class="phy-note">Bars span every 20 MHz channel a radio occupies (primary channel plus width). Bottom row: AP radios on each channel.${hidden ? ` ${hidden} radio(s) not drawn.` : ""}</div></figure>`;
  })() : "";

  // Roaming swimlanes: one row per AP, sessions coloured by band, failures on top.
  const apOrder = [...new Set(d.sess.map((s) => s.ap))].slice(0, 12);
  const RH = 22, LW = 150, TW = W - LW - 14, top = 24;
  const tx = (t) => LW + ((Math.max(d.t0, Math.min(d.t1, t)) - d.t0) / (d.t1 - d.t0)) * TW;
  const laneH = top + apOrder.length * RH + 24;
  const roamHtml = d.sess.length ? `<figure class="phy-chart"><figcaption>Roaming timeline <em>${E(d.sess.length)} session(s) on ${E(apOrder.length)} AP(s)</em></figcaption>
    <div class="phy-legend">${["24", "5", "6"].filter((b) => d.sess.some((s) => s.band === b)).map((b) =>
      `<span><i style="background:${BAND[b].color}"></i>${BAND[b].label}</span>`).join("")}<span><i style="background:${STATUS.critical.color}"></i>${STATUS.critical.icon} Disconnect / failure</span></div>
    <svg viewBox="0 0 ${W} ${laneH}" role="img" aria-label="Roaming timeline">
      ${d.negEvents.filter((e) => e.t >= d.t0).map((e) => `<rect x="${tx(e.t) - 1.5}" y="4" width="3" height="14" rx="1.5" fill="${STATUS.critical.color}"
        data-tip="${E(`${ctx.fmtTime(e.t)} — ${e.type}${e.reasonText ? ` (reason ${e.reasonText})` : ""}`)}"/>`).join("")}
      ${apOrder.map((ap, i) => `<text x="${LW - 8}" y="${top + i * RH + 15}" text-anchor="end">${E(d.apName(ap).slice(0, 22))}</text>
        <line x1="${LW}" x2="${W - 14}" y1="${top + i * RH + RH - 1}" y2="${top + i * RH + RH - 1}" class="g"/>`).join("")}
      ${d.sess.filter((s) => apOrder.includes(s.ap)).map((s) => {
        const x1 = tx(s.start); const x2 = Math.max(x1 + 3, tx(s.end || d.t1));
        const i = apOrder.indexOf(s.ap);
        return `<rect x="${x1}" y="${top + i * RH + 4}" width="${x2 - x1}" height="${RH - 9}" rx="4" fill="${BAND[s.band].color}"
          data-tip="${E(`${d.apName(s.ap)} · ${BAND[s.band].label}${s.ssid ? ` · ${s.ssid}` : ""}\n${ctx.fmtTime(s.start)} → ${s.end ? ctx.fmtTime(s.end) : "now"}`)}"/>`;
      }).join("")}
      ${Array.from({ length: 5 }, (_, i) => d.t0 + ((d.t1 - d.t0) * i) / 4).map((x, i) =>
        `<text x="${tx(x)}" y="${laneH - 6}" text-anchor="${i === 0 ? "start" : i === 4 ? "end" : "middle"}">${E(fmtShort(x))}</text>`).join("")}
    </svg></figure>` : "";

  // Disconnect / failure causes.
  const reasons = [...d.reasonCounts].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const maxR = Math.max(1, ...reasons.map(([, n]) => n));
  const reasonHtml = reasons.length ? `<figure class="phy-chart"><figcaption>Disconnect and failure causes
      <em>${E(d.negEvents.length)} of ${E(d.evs.length)} events</em></figcaption><div class="phy-bars">${reasons.map(([k, n]) =>
      `<div data-tip="${E(`${k}: ${n}`)}"><span>${E(k)}</span><i style="width:${(n / maxR) * 100}%;background:${STATUS.critical.color}"></i><b>${n}</b></div>`).join("")}</div></figure>` : "";

  ctx.mount.innerHTML = `
<style>
  .phy{--phy-surface:var(--surface,#13161c);--phy-fg:var(--fg,#ecece8);--phy-muted:var(--muted,#9aa0ab);
    --phy-border:var(--border,#2a303b);--phy-grid:#262b35;--phy-neutral:#4a505c;
    font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--phy-fg);margin-top:12px;position:relative}
  .phy h3{font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--phy-muted);margin:22px 0 10px}
  .phy section{min-width:0}
  .phy-muted{color:var(--phy-muted)}
  .phy-head{display:grid;grid-template-columns:minmax(180px,240px) 1fr;gap:18px;padding:14px 16px;border:1px solid var(--phy-border);
    border-left:5px solid var(--c);border-radius:8px;background:var(--phy-surface)}
  .phy-kicker{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--phy-muted)}
  .phy-verdict .phy-badge{font-size:18px;padding:4px 12px;margin:6px 0 8px}
  .phy-counts{display:flex;flex-wrap:wrap;gap:4px}
  .phy-head dl{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin:0;min-width:0}
  .phy-head dt{color:var(--phy-muted)} .phy-head dd{margin:0;overflow-wrap:anywhere}
  .phy-badge{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--c);color:var(--phy-fg);
    border-radius:999px;padding:1px 8px;font-size:11px;font-weight:600;white-space:nowrap;background:color-mix(in srgb,var(--c) 14%,transparent)}
  .phy-badge b{color:var(--c)}
  .phy-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px}
  .phy-tile{border:1px solid var(--phy-border);border-top:4px solid var(--c);border-radius:8px;padding:10px 12px;background:var(--phy-surface)}
  .phy-tl{font-size:12px;color:var(--phy-muted)}
  .phy-tv{font-size:24px;font-weight:600;margin:2px 0 4px}.phy-tv small{font-size:12px;font-weight:400;color:var(--phy-muted);margin-left:3px}
  .phy-tn{font-size:11px;color:var(--phy-muted);margin-top:4px}
  .phy-meter{position:relative;display:flex;gap:2px;height:6px;margin-top:10px}
  .phy-meter i{display:block;height:100%;opacity:.55}.phy-meter i:first-child{border-radius:3px 0 0 3px}.phy-meter i:last-of-type{border-radius:0 3px 3px 0}
  .phy-meter s{position:absolute;top:-4px;width:4px;height:14px;margin-left:-2px;border-radius:2px;background:var(--phy-fg);box-shadow:0 0 0 2px var(--phy-surface)}
  .phy-scale{display:flex;justify-content:space-between;font-size:10px;color:var(--phy-muted);margin-top:3px}
  .phy-facts{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px;margin-top:8px}
  .phy-facts div{border:1px solid var(--phy-border);border-left:4px solid var(--c);border-radius:6px;padding:6px 10px;background:var(--phy-surface)}
  .phy-facts span{display:block;font-size:11px;color:var(--phy-muted)}
  .phy-findings{display:grid;gap:8px}
  .phy-f{display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:start;border:1px solid var(--phy-border);
    border-left:4px solid var(--c);border-radius:8px;padding:10px 12px;background:var(--phy-surface)}
  .phy-f p{margin:4px 0 0}.phy-adv{color:var(--phy-muted)}
  .phy-facet{font-size:11px;color:var(--phy-muted);margin-left:4px}
  .phy details{margin-top:10px}.phy summary{cursor:pointer;color:var(--phy-muted)}
  .phy details ul{list-style:none;padding:0;display:grid;gap:4px}
  .phy-charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,460px),1fr));gap:10px}
  .phy-chart{margin:0 0 10px;border:1px solid var(--phy-border);border-radius:8px;padding:10px 12px;background:var(--phy-surface);min-width:0}
  .phy-chart figcaption{font-weight:600;margin-bottom:6px}.phy-chart figcaption em{font-style:normal;font-weight:400;color:var(--phy-muted);margin-left:6px}
  .phy-chart svg{display:block;width:100%;height:auto;overflow:visible}
  .phy-chart svg text{fill:var(--phy-muted);font-size:11px;font-variant-numeric:tabular-nums}
  .phy-chart svg .g{stroke:var(--phy-grid);stroke-width:1}.phy-chart svg .a{stroke:var(--phy-neutral);stroke-width:1}
  .phy-chart svg .x{stroke:var(--phy-fg);stroke-width:1;opacity:.5}
  .phy-legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--phy-muted);margin:2px 0 6px}
  .phy-legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
  .phy-legend b{color:var(--phy-fg);font-weight:600;margin-left:3px}
  .phy-note{font-size:11px;color:var(--phy-muted);margin-top:4px}
  .phy-dash{display:inline-block;width:14px;border-top:1px dashed ${STATUS.critical.color};margin-right:6px;vertical-align:middle}
  .phy-stack{display:flex;gap:2px;height:22px;margin:4px 0 8px}
  .phy-stack i{display:block;height:100%}.phy-stack i:first-child{border-radius:4px 0 0 4px}.phy-stack i:last-child{border-radius:0 4px 4px 0}
  .phy .idle{background:var(--phy-grid)!important}
  .phy-bars{display:grid;gap:5px}
  .phy-bars div{display:grid;grid-template-columns:minmax(120px,38%) 1fr 32px;gap:8px;align-items:center}
  .phy-bars span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .phy-bars i{display:block;height:12px;border-radius:0 4px 4px 0;min-width:3px}
  .phy-bars b{text-align:right;font-variant-numeric:tabular-nums}
  .phy-tip{position:fixed;z-index:50;pointer-events:none;background:#0b0d11;color:var(--phy-fg);border:1px solid var(--phy-border);
    border-radius:6px;padding:6px 9px;font-size:12px;white-space:pre-line;max-width:320px;box-shadow:0 4px 14px rgba(0,0,0,.4);display:none}
  @media (max-width:640px){.phy-head{grid-template-columns:1fr}}
</style>
<div class="phy">${header}${tiles}${findingsHtml}${tsHtml}
  <section><h3>Radio and roaming</h3>${airtime}${chanHtml}${roamHtml}${reasonHtml}
    ${airtime || chanHtml || roamHtml || reasonHtml ? "" : `<p class="phy-muted">No radio, session or event data was returned.</p>`}</section>
  <div class="phy-tip"></div></div>`;

  // ---- Hover layer --------------------------------------------------------------
  const root = ctx.mount.querySelector(".phy");
  const tip = root.querySelector(".phy-tip");
  const show = (text, ev) => {
    tip.textContent = text;
    tip.style.display = "block";
    const x = Math.min(ev.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    const y = ev.clientY + 16 + tip.offsetHeight > window.innerHeight ? ev.clientY - tip.offsetHeight - 12 : ev.clientY + 16;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  };
  const hide = () => { tip.style.display = "none"; };
  root.addEventListener("mousemove", (ev) => {
    const wrap = ev.target.closest?.("[data-chart]");
    if (wrap) {
      const c = charts.get(wrap.dataset.chart);
      const svg = wrap.querySelector("svg");
      const r = svg.getBoundingClientRect();
      const vx = ((ev.clientX - r.left) / r.width) * W;
      if (vx < c.L || vx > W - c.R) { hide(); svg.querySelector(".x").setAttribute("visibility", "hidden"); return; }
      const tq = d.t0 + ((vx - c.L) / (W - c.L - c.R)) * (d.t1 - d.t0);
      const rows = c.lines.map((l) => {
        let best = null;
        for (const p of l.pts) if (!best || Math.abs(p[0] - tq) < Math.abs(best[0] - tq)) best = p;
        return best ? { name: l.name, p: best } : null;
      }).filter(Boolean);
      if (!rows.length) return;
      const near = rows[0].p[0];
      const x = c.sx(near);
      const xl = svg.querySelector(".x");
      xl.setAttribute("x1", x); xl.setAttribute("x2", x); xl.setAttribute("visibility", "visible");
      const ev2 = c.markers.filter((m) => Math.abs(m.t - near) <= (d.duration === "7d" ? 1800 : 300));
      show(`${ctx.fmtTime(near)}\n${rows.map((rw) => `${rw.name}: ${fmtVal(rw.p[1], c.unit)}`).join("\n")}` +
        (ev2.length ? `\n✕ ${ev2.length} failure event(s) nearby` : ""), ev);
      return;
    }
    const t = ev.target.closest?.("[data-tip]");
    if (t) show(t.getAttribute("data-tip"), ev); else hide();
  });
  root.addEventListener("mouseleave", () => {
    hide();
    root.querySelectorAll(".phy-chart svg .x").forEach((l) => l.setAttribute("visibility", "hidden"));
  });
}
