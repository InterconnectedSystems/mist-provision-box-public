// Ported from mist_disconnect_console.py lines 949-1017 and 1078-1123.
// Payload → internal record shape. Absent Python dict keys are None, so every
// field normalizes to null rather than undefined.

import {
  asArray, asBool, asRecord, epochS, hexMac, isNegative, num, pyGet,
} from "./util.js";

/** Python dict.get() yields None for a missing key; JS yields undefined. */
function orNull(v) {
  return v === undefined ? null : v;
}

export function pickStats(raw) {
  return {
    mac: String(raw.mac || ""),
    hostname: orNull(raw.hostname || raw.device),
    manufacture: orNull(raw.manufacture || raw.client_manufacture),
    os: orNull(raw.os),
    model: orNull(raw.model),
    ssid: orNull(raw.ssid),
    vlan: orNull(pyGet(raw, "vlan_id", raw.vlan)),
    ip: orNull(raw.ip || raw.ip6),
    ap: orNull(raw.ap || raw.ap_mac),
    band: raw.band !== null && raw.band !== undefined ? String(raw.band) : null,
    channel: orNull(raw.channel),
    proto: orNull(raw.proto || raw.protocol),
    rssi: num(pyGet(raw, "rssi", raw.rssi_dbm)),
    snr: num(pyGet(raw, "snr", raw.snr_db)),
    txRate: num(raw.tx_rate),
    rxRate: num(raw.rx_rate),
    uptime: num(raw.uptime),
    lastSeen: epochS(pyGet(raw, "last_seen", raw.timestamp)),
    txBytes: num(raw.tx_bytes),
    rxBytes: num(raw.rx_bytes),
    username: orNull(raw.username),
    keyMgmt: orNull(raw.key_mgmt),
    txRetries: num(pyGet(raw, "tx_retries", pyGet(raw, "num_tx_retries", raw.tx_retry))),
    rxRetries: num(pyGet(raw, "rx_retries", pyGet(raw, "num_rx_retries", raw.rx_retry))),
    dualBand: asBool(raw.dual_band),
  };
}

export function pickEvent(raw) {
  const typ = String(raw.type || raw.type_code || "unknown");
  const text = String(raw.text || "");
  return {
    timestamp: epochS(raw.timestamp) || 0,
    type: typ,
    text,
    ap: String(raw.ap || ""),
    ssid: String(raw.ssid || ""),
    band: String(raw.band || ""),
    channel: orNull(raw.channel),
    reason: orNull(pyGet(raw, "reason_code", raw.reason)),
    negative: isNegative(typ, text),
  };
}

export function pickSession(raw) {
  const ap = String(raw.ap || raw.ap_mac || "");
  const bssid = String(raw.bssid || "");
  return {
    ap: ap || bssid,
    bssid,
    ssid: String(raw.ssid || ""),
    band: String(raw.band || ""),
    connect: epochS(raw.connect),
    disconnect: epochS(raw.disconnect),
    duration: num(raw.duration),
  };
}

export function asResults(payload) {
  if (payload === null || payload === undefined) return [];
  if (Array.isArray(payload)) return payload.filter((r) => asRecord(r));
  const rec = asRecord(payload);
  if (!rec) return [];
  return asArray(rec.results || rec.data || []);
}

/** AP base MAC plus per-radio BSSIDs from radio_stat — RRM `ap` is often the base MAC. */
export function deviceRadioMacs(dev) {
  const out = new Set();
  if (!dev) return out;
  for (const k of ["mac", "ap", "ap_mac", "bssid", "radio_mac"]) {
    const h = hexMac(dev[k]);
    if (h.length === 12) out.add(h);
  }
  const rs = asRecord(dev.radio_stat) || {};
  for (const v of Object.values(rs)) {
    if (!asRecord(v)) continue;
    for (const k of ["mac", "bssid", "ap_mac", "radio_mac"]) {
      const h = hexMac(v[k]);
      if (h.length === 12) out.add(h);
    }
  }
  return out;
}

export function expandClientAps(sessions, events, stats, inventory) {
  const seeds = new Set();
  for (const s of sessions || []) {
    for (const k of ["ap", "bssid"]) {
      const h = hexMac(s[k]);
      if (h.length === 12) seeds.add(h);
    }
  }
  for (const e of events || []) {
    const h = hexMac(e.ap);
    if (h.length === 12) seeds.add(h);
  }
  const live = hexMac((stats || {}).ap);
  if (live.length === 12) seeds.add(live);
  const families = (inventory || []).map((d) => deviceRadioMacs(d));
  const out = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of families) {
      let intersects = false;
      let subset = true;
      for (const m of g) {
        if (out.has(m)) intersects = true;
        else subset = false;
      }
      if (intersects && !subset) {
        for (const m of g) out.add(m);
        changed = true;
      }
    }
  }
  return out;
}
