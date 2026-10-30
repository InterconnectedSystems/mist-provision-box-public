// Ported from mist_disconnect_console.py lines 649-742 and 1018-1299.
// RRM occupancy rows, Radio Management event normalization, and the AP-keyed
// radar store that survives a site-wide neighbor-radar storm.

import { isRadarEvent, radarEventSig, sessionCovers } from "./radar.js";
import {
  RRM_EVENT_LABELS, RRM_OTHER_KEEP, RADIO_EVENTS_DURATION,
  asRecord, epochS, hexMac, isEmpty, minStr, num, pyGet, pyRound, stackPcts, utilPct,
} from "./util.js";

export function heardRssi(v) {
  const n = num(v);
  if (n === null || Number(n) === 0) return null;
  return Number(n);
}

/** Normalize RRM / occupancy payloads: list, {results:[]}, {channels:[]}, or {36:{...}}. */
export function rrmRowsFrom(raw) {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) {
    const out = [];
    for (const x of raw) {
      if (!asRecord(x)) continue;
      if (x.channel !== undefined && x.channel !== null) out.push(x);
      else if (x.chan !== undefined && x.chan !== null) out.push(x);
      else if (x.ch !== undefined && x.ch !== null) out.push(x);
      else out.push(...rrmRowsFrom(x));
    }
    return out;
  }
  const rec = asRecord(raw);
  if (!rec) return [];
  for (const key of ["results", "channels", "channel_usage", "considerations", "data", "items"]) {
    if (rec[key] !== undefined && rec[key] !== null) {
      const got = rrmRowsFrom(rec[key]);
      if (got.length) return got;
    }
  }
  const keys = Object.keys(rec);
  if (keys.length && keys.every((k) => num(k) !== null)) {
    // Python preserves insertion order for {"36":…,"149":…}; JS reorders
    // integer-like keys, so sort explicitly for a deterministic channel order.
    const out = [];
    for (const k of keys.slice().sort((a, b) => num(a) - num(b))) {
      const v = rec[k];
      if (!asRecord(v)) continue;
      const row = { ...v };
      if (!Object.prototype.hasOwnProperty.call(row, "channel")) {
        row.channel = Math.trunc(num(k) || 0);
      }
      out.push(row);
    }
    return out;
  }
  return [];
}

export function occField(row, ...names) {
  const nested = asRecord(row.occupancy) ? row.occupancy : {};
  const usage = asRecord(row.channel_usage) ? row.channel_usage : {};
  for (const n of names) {
    for (const src of [row, nested, usage]) {
      if (!isEmpty(src) && src[n] !== undefined && src[n] !== null) {
        // RRM occupancy fields are 0-1 fractions, so a bare 1 means 100%.
        const p = utilPct(src[n], { fraction: true });
        if (p) return p;
      }
    }
  }
  return 0;
}

/**
 * Portal bars: wifi occupancy split Site vs External, plus non_wifi.
 *
 * Live considerations often omit the `wifi` example field. `util_score_other` is
 * still the other-BSS occupancy fraction and must be used even when non_wifi > 0.
 * Unknown wifi (no RSSI) is External (teal), not Site — unless a site AP is on
 * this channel or same-site RSSI was heard.
 */
export function rrmOccupancyStack(row, siteOnChannel = false) {
  let nw = occField(row, "non_wifi", "nonWifi", "non_wifi_occupancy");
  if (nw === 0) nw = occField(row, "util_score_non_wifi", "util_non_wifi");
  let wifi = occField(row, "wifi", "wifi_occupancy", "util_wifi", "occupancy_wifi");
  if (wifi === 0) wifi = occField(row, "util_score_other", "util_other", "other", "util_rx_other_bss");
  const rssi = heardRssi(row.rssi);
  const otherRssi = heardRssi(row.other_rssi);
  const otherSsid = String(row.other_ssid || "").trim();
  if (wifi <= 0) return stackPcts(0, 0, nw);
  const siteHeard = rssi !== null;
  const extHeard = otherRssi !== null || Boolean(otherSsid);
  if (siteHeard && !extHeard) return stackPcts(wifi, 0, nw);
  if (extHeard && !siteHeard) return stackPcts(0, wifi, nw);
  if (siteHeard && extHeard && rssi !== null && otherRssi !== null) {
    const wr = 10 ** (rssi / 10.0);
    const wo = 10 ** (otherRssi / 10.0);
    const den = wr + wo || 1.0;
    const site = Math.trunc(pyRound((wifi * wr) / den));
    const ext = Math.max(0, wifi - site);
    return stackPcts(site, ext, nw);
  }
  if (siteHeard || siteOnChannel) return stackPcts(wifi, 0, nw);
  return stackPcts(0, wifi, nw);
}

/** Alias kept for self-test / callers — occupancy, not util_score. */
export function rrmChannelStack(row) {
  return rrmOccupancyStack(row);
}

/** listSiteRrmEvents query. Mist returns 400 'valid band is required' without band. */
export function rrmEventsQuery(band, page = 1, limit = 100, duration = RADIO_EVENTS_DURATION) {
  const b = String(band ?? "").trim();
  if (!b) throw new Error("valid band is required");
  return { band: b, duration, limit: Math.trunc(limit), page: Math.trunc(page) };
}

export function attachApNames(radioEvents, inventory) {
  const names = {};
  for (const d of inventory || []) {
    const h = hexMac(d.mac);
    if (h) names[h] = String(d.name || "");
  }
  for (const re of radioEvents) {
    if (!re.apName) re.apName = names[re.ap || ""] || "";
  }
  return radioEvents;
}

export function rrmEventLabel(event) {
  const ev = String(event ?? "").trim();
  if (Object.prototype.hasOwnProperty.call(RRM_EVENT_LABELS, ev)) return RRM_EVENT_LABELS[ev];
  const title = ev
    .replace(/-/g, " ")
    .replace(/_/g, " ")
    .replace(/[A-Za-z]+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  return title || "Radio event";
}

export function pickRrmEvent(raw) {
  const ev = String(raw.event || raw.type || "");
  const preCh = num(pyGet(raw, "pre_channel", raw.preChannel));
  const ch = num(raw.channel);
  let changed = false;
  if (preCh !== null && preCh !== 0 && ch !== null && ch !== 0) {
    changed = Math.trunc(preCh) !== Math.trunc(ch);
  }
  const ap = hexMac(
    raw.ap || raw.ap_mac || raw.apMac || raw.mac || raw.device_mac || raw.deviceMac,
  );
  return {
    timestamp: epochS(raw.timestamp) || 0,
    ap,
    apName: String(raw.ap_name || raw.apName || ""),
    band: String(raw.band || ""),
    channel: ch,
    preChannel: preCh,
    bandwidth: num(raw.bandwidth),
    preBandwidth: num(pyGet(raw, "pre_bandwidth", raw.preBandwidth)),
    power: num(raw.power),
    prePower: num(pyGet(raw, "pre_power", raw.prePower)),
    event: ev,
    label: rrmEventLabel(ev),
    usage: String(raw.usage || ""),
    preUsage: String(raw.pre_usage || raw.preUsage || ""),
    channelChanged: changed,
  };
}

const sigKey = (parts) => JSON.stringify(parts);

/**
 * In-memory radar store keyed by AP MAC.
 *
 * Site RRM is a firehose (no AP filter). Correlation looks up radars by the
 * APs this client actually used, including radio_stat BSSID aliases.
 */
export class RadioEventStore {
  constructor(clientAps = null, families = null) {
    this.canon = new Map();
    this.members = new Map();
    for (const g of families || []) {
      const cleaned = new Set();
      for (const x of g) {
        const h = hexMac(x);
        if (h.length === 12) cleaned.add(h);
      }
      if (cleaned.size === 0) continue;
      // Python min() over a set of strings is lexicographic.
      const root = minStr(cleaned);
      if (!this.members.has(root)) this.members.set(root, new Set());
      for (const m of cleaned) this.members.get(root).add(m);
      for (const m of cleaned) this.canon.set(m, root);
    }
    const seeds = new Set();
    for (const a of clientAps || []) {
      const h = hexMac(a);
      if (h.length === 12) seeds.add(h);
    }
    const expanded = new Set();
    for (const s of seeds) {
      const root = this.canon.get(s) ?? s;
      expanded.add(s);
      expanded.add(root);
      for (const m of this.members.get(root) || []) expanded.add(m);
    }
    this.clientAps = expanded;
    this.by_ap = new Map();
    this.radars_by_ap = new Map();
    this.radars = [];
    this.kept = [];
    this.others = [];
    this.scanned = 0;
    this.dropped = 0;
  }

  key(mac) {
    const h = hexMac(mac);
    return this.canon.get(h) ?? h;
  }

  related(a, b) {
    const ha = hexMac(a);
    const hb = hexMac(b);
    if (!ha || !hb) return false;
    if (ha === hb) return true;
    const ka = this.key(ha);
    const kb = this.key(hb);
    return Boolean(ka && ka === kb);
  }

  /**
   * Ingest one RRM row.
   *
   * Radar rows are ALWAYS indexed by AP (neighbor storms must not discard a
   * scanned DFS hit). The UI export only keeps client-AP rows plus a sample
   * of site-wide noise. Returns a kind used by adaptive paging:
   * radar-client | client | radar | other | drop | skip.
   */
  add(ev) {
    if (!ev) return "skip";
    this.scanned += 1;
    const ap = hexMac(ev.ap);
    const radar = isRadarEvent(ev);
    let onClient = true;
    if (ap && this.clientAps.size) {
      onClient = this.clientAps.has(ap) || [...this.clientAps].some((c) => this.related(ap, c));
    } else if (this.clientAps.size) {
      onClient = false;
    }

    if (radar) {
      this.radars.push(ev);
      if (ap) {
        pushInto(this.radars_by_ap, ap, ev);
        const ck = this.key(ap);
        if (ck && ck !== ap) pushInto(this.radars_by_ap, ck, ev);
      }
    }

    let keep = false;
    let keepOther = false;
    if (radar) keep = onClient;
    else if (onClient) keep = true;
    else if (this.others.length < RRM_OTHER_KEEP) {
      keep = true;
      keepOther = true;
    }
    if (!keep) {
      this.dropped += 1;
      return radar ? "radar" : "drop";
    }

    this.kept.push(ev);
    if (ap) {
      pushInto(this.by_ap, ap, ev);
      const ck = this.key(ap);
      if (ck && ck !== ap) pushInto(this.by_ap, ck, ev);
    }
    if (keepOther) this.others.push(ev);
    if (radar) return "radar-client";
    return onClient ? "client" : "other";
  }

  addMany(events) {
    for (const ev of events || []) this.add(ev);
  }

  radarsOnAp(ap) {
    const h = hexMac(ap);
    const seen = new Set();
    const out = [];
    const keys = new Set([h, this.key(h)]);
    for (const m of this.members.get(this.key(h)) || []) keys.add(m);
    for (const k of keys) {
      for (const re of this.radars_by_ap.get(k) || []) {
        const sig = sigKey([re.ap ?? null, re.timestamp ?? null, re.event ?? null, re.channel ?? null]);
        if (seen.has(sig)) continue;
        seen.add(sig);
        out.push(re);
      }
    }
    return out;
  }

  hitsForSession(sess) {
    const out = this.radarsOnAp(sess.ap).filter((re) => sessionCovers(sess, epochS(re.timestamp) || 0));
    if (sess.bssid && hexMac(sess.bssid) !== hexMac(sess.ap)) {
      for (const re of this.radarsOnAp(sess.bssid)) {
        if (sessionCovers(sess, epochS(re.timestamp) || 0) && !out.includes(re)) out.push(re);
      }
    }
    out.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return out;
  }

  /**
   * Each radar row is attached to at most one covering session.
   *
   * Mist session search often returns two near-duplicate associations
   * (connect times a fraction of a second apart). Matching both prints
   * two identical session-on-radar banners for one DFS hit.
   */
  hitsForSessions(sessions) {
    const best = new Map();
    for (const s of sessions || []) {
      for (const re of this.hitsForSession(s)) {
        const sig = sigKey(radarEventSig(re));
        const prev = best.get(sig);
        if (prev === undefined) {
          best.set(sig, [s, re]);
          continue;
        }
        const ps = prev[0];
        const sDur = Number(s.duration || 0);
        const pDur = Number(ps.duration || 0);
        const sCon = -Number(epochS(s.connect) || 0);
        const pCon = -Number(epochS(ps.connect) || 0);
        const better = sDur > pDur || (sDur === pDur && sCon > pCon);
        if (better) best.set(sig, [s, re]);
      }
    }
    return [...best.values()];
  }

  clientRadarEvents(sessions) {
    const seen = new Set();
    const rows = [];
    for (const [, re] of this.hitsForSessions(sessions)) {
      const key = sigKey([re.ap ?? null, re.timestamp ?? null, re.event ?? null, re.channel ?? null]);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(re);
    }
    rows.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return rows;
  }

  exportEvents() {
    const seen = new Set();
    const out = [];
    for (const ev of this.kept) {
      const key = sigKey([
        ev.ap ?? null, ev.timestamp ?? null, ev.event ?? null, ev.channel ?? null, ev.band ?? null,
      ]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ev);
    }
    out.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return out;
  }
}

function pushInto(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}
