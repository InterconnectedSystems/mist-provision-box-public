// Ported from mist_disconnect_console.py lines 29-380 (constants + primitives).
//
// Python/JS semantic gaps handled here, once, so the rest of the engine can be
// a literal transcription:
//   * pyRound()  — Python round() is half-to-even; Math.round() is half-up.
//   * utilPct()  — Python distinguishes int 1 (= 1%) from float 1.0 (= 100%).
//     JSON.parse collapses both to the number 1, so the caller declares which
//     it has: RRM occupancy fields pass {fraction:true}, radio_stat does not.
//   * pyGet()    — dict.get(k, default) returns the stored value when the key
//     exists even if that value is null; `a ?? b` would fall through.

export const DEFAULT_HOST = "api.gc2.mist.com";
/**
 * Every Mist API region, consolidated from the three different lists the Python
 * scripts carried (mist_ip_blocks.py had 13, mist_switch_port_inventory.py had 12,
 * this extension had 9). Label and portal come from mist_ip_blocks.py MIST_CLOUDS
 * so the region picker reads the way the scripts' menus did.
 *
 * MIST_HOSTS order is load-bearing: tests/policy.test.js asserts manifest.json's
 * host_permissions matches it exactly, in order.
 */
export const MIST_REGIONS = [
  { label: "Global 01", portal: "manage.mist.com", host: "api.mist.com" },
  { label: "Global 02", portal: "manage.gc1.mist.com", host: "api.gc1.mist.com" },
  { label: "Global 03", portal: "manage.ac2.mist.com", host: "api.ac2.mist.com" },
  { label: "Global 04", portal: "manage.gc2.mist.com", host: "api.gc2.mist.com" },
  { label: "Global 05", portal: "manage.gc4.mist.com", host: "api.gc4.mist.com" },
  { label: "EMEA 01", portal: "manage.eu.mist.com", host: "api.eu.mist.com" },
  { label: "EMEA 02", portal: "manage.gc3.mist.com", host: "api.gc3.mist.com" },
  { label: "EMEA 03", portal: "manage.ac6.mist.com", host: "api.ac6.mist.com" },
  { label: "EMEA 04", portal: "manage.gc6.mist.com", host: "api.gc6.mist.com" },
  { label: "APAC 01", portal: "manage.ac5.mist.com", host: "api.ac5.mist.com" },
  { label: "APAC 02", portal: "manage.gc5.mist.com", host: "api.gc5.mist.com" },
  { label: "APAC 03", portal: "manage.gc7.mist.com", host: "api.gc7.mist.com" },
  { label: "US Gov", portal: "manage.us.mist-federal.com", host: "api.us.mist-federal.com" },
];

export const MIST_HOSTS = MIST_REGIONS.map((r) => r.host);

/** The region the Python scripts hardcoded, and the console's default. */
export const DEFAULT_MIST_HOST = "api.gc2.mist.com";
export const TIMEOUT = 25;
export const DEMO_MAC = "0a0027c1e001";
export const WINDOW_DHCP_S = 120;
export const WINDOW_HANDSHAKE_S = 45;
export const WINDOW_CLUSTER_S = 300;
export const WINDOW_RADIO_DFS_S = 120;
export const WINDOW_RADIO_RRM_S = 300;
export const WINDOW_CALL_S = 30;
export const PINGPONG_MIN = 4;
export const RADIO_EVENTS_DURATION = "7d";
// listSiteRrmEvents requires dot11_band. Portal Radio Events = union of 5 / 24 / 6.
export const RRM_FETCH_BANDS = ["5", "24", "6"];
// No AP filter on listSiteRrmEvents. We SCAN time slices and KEEP only
// radar + this-client-AP rows in RadioEventStore. Never page one 7d firehose.
export const RRM_OTHER_KEEP = 200;
export const RRM_SLICE_1D_S = 3 * 3600;
export const RRM_SLICE_1W_S = 6 * 3600;
export const RRM_PAGES_SLICE_5 = 6;
export const RRM_PAGES_SLICE_OTHER = 1;
export const RRM_PAGES_SHORT_5 = 8;
export const RRM_PAGES_SHORT_OTHER = 2;
// Walk further through a neighbor-radar storm so the client's DFS hit is not
// buried behind page 6 of a 3-hour slice. Login / live do not use this cap.
export const RRM_PAGES_ADAPT_5 = 24;
export const RRM_PAGES_LIVE_5 = 3;
export const RRM_PAGES_LIVE_OTHER = 1;
export const RRM_TIMEOUT = 12;
export const MAX_RADAR_CORRELATIONS = 80;
export const SESSION_PAGES = 6;
export const EVENT_PAGES = 4;

// Portal Radio Management → Radio Events wording.
export const RRM_EVENT_LABELS = {
  "interference-ap-co-channel": "Interference AP co-channel",
  "interference-ap-non-wifi": "Interference AP non wifi",
  "neighbor-ap-down": "Neighbor AP down",
  "neighbor-ap-recovered": "Neighbor AP recovered",
  "radar-detected": "Radar detected",
  "rrm-radar": "Post radar",
  "scheduled-site_rrm": "Scheduled site RRM",
  "triggered-site_rrm": "Triggered site RRM",
};
export const DISRUPTIVE_RADIO = new Set([
  "radar-detected",
  "rrm-radar",
  "interference-ap-co-channel",
  "interference-ap-non-wifi",
  "triggered-site_rrm",
]);

export const REASON_CODES = {
  1: "Unspecified",
  2: "Previous authentication no longer valid",
  3: "STA leaving IBSS/ESS",
  4: "Disassociated due to inactivity",
  5: "AP cannot handle all currently associated STAs",
  6: "Class 2 frame from nonauthenticated STA",
  7: "Class 3 frame from nonassociated STA",
  8: "STA leaving BSS",
  9: "STA requesting (re)association is not authenticated",
  10: "Unacceptable power capability",
  13: "Invalid information element",
  14: "MIC failure",
  15: "4-way handshake timeout",
  16: "Group key handshake timeout",
  17: "IE in 4-way handshake different from (re)assoc",
  18: "Invalid group cipher",
  19: "Invalid pairwise cipher",
  20: "Invalid AKMP",
  23: "IEEE 802.1X authentication failed",
  39: "The QoS AP lacks sufficient bandwidth",
};

export const NEGATIVE = [
  "DEAUTH", "DISASSOC", "FAIL", "DENIED", "TIMEOUT", "TIMED_OUT", "STUCK",
  "DISCONNECT", "TERMINATED", "BLOCKED", "SPOOF", "NAK", "BAD_IP", "BAD IP",
];
// Mist Insights: DHCP Success / IP Assigned / DNS Success are POSITIVE.
// Do not treat the letters DHCP/DNS/ARP as failure by themselves.

/** Python `d.get(key, default)` — present-but-null keeps null, absent takes the default. */
export function pyGet(obj, key, dflt) {
  if (obj && Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  return dflt;
}

/** Python round() — half away from zero is wrong; Python rounds half to even. */
export function pyRound(x) {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Python `min(set_of_strings)` — lexicographic, not numeric. */
export function minStr(values) {
  let best = null;
  for (const v of values) {
    if (best === null || v < best) best = v;
  }
  return best;
}

/** Python truthiness for containers: [] and {} are falsy there, truthy in JS. */
export function isEmpty(v) {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (v instanceof Set || v instanceof Map) return v.size === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return !v;
}

/** Python int() on a str/number: truncates toward zero, rejects non-integer text. */
function pyInt(v) {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError("int() of non-finite");
    return Math.trunc(v);
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  const s = String(v).trim();
  if (!/^[+-]?\d+$/.test(s)) throw new TypeError("invalid int");
  return Number(s);
}

export function describeReason(code) {
  if (code === null || code === undefined || code === "") return null;
  let n;
  try {
    n = pyInt(code);
  } catch {
    return String(code);
  }
  const name = REASON_CODES[n];
  return name ? `${n} — ${name}` : String(n);
}

export function normalizeMac(raw) {
  const cleaned = String(raw ?? "")
    .toLowerCase()
    .split("")
    .filter((c) => "0123456789abcdef".includes(c))
    .join("");
  if (cleaned.length !== 12) {
    throw new Error("MAC must be 12 hex digits (colons/dashes optional).");
  }
  return cleaned;
}

export function formatMac(mac) {
  const n = hexMac(mac);
  if (n.length !== 12) return mac;
  return n.match(/.{2}/g).join(":");
}

export function hexMac(raw) {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "");
}

export function num(v) {
  if (typeof v === "boolean") return null;
  if (typeof v === "number") return Number.isNaN(v) ? null : v;
  if (typeof v === "string" && v.trim()) {
    const t = v.trim();
    // Python float() rejects 0x/0o/0b literals that Number() would accept.
    if (/^[+-]?0[xXoObB]/.test(t)) return null;
    const f = Number(t);
    return Number.isNaN(f) ? null : f;
  }
  return null;
}

/** Unix seconds. Mist mostly returns seconds; some payloads use milliseconds. */
export function epochS(v) {
  let n = num(v);
  if (n === null) return null;
  n = Number(n);
  if (Math.abs(n) >= 1e11) n /= 1000.0;
  return n;
}

export function durationSeconds(duration) {
  const d = String(duration ?? "").trim().toLowerCase();
  const map = { "1h": 3600, "6h": 6 * 3600, "1d": 86400, "7d": 7 * 86400, "1w": 7 * 86400 };
  return Object.prototype.hasOwnProperty.call(map, d) ? map[d] : 86400;
}

/**
 * Lookback split into independent [start, end] windows, newest first.
 *
 * Mist listSiteRrmEvents cannot filter by AP/MAC/event-type. Paging one 24h
 * window newest-first lets a campus radar storm fill every page. Each slice
 * is its own start/end so hour 18 is fetched even when hour 0-2 is huge.
 */
export function rrmTimeSlices(duration, now = null) {
  const nowI = Math.trunc(now !== null && now !== undefined ? now : Date.now() / 1000);
  const total = durationSeconds(duration);
  if (total <= 6 * 3600) return [[nowI - total, nowI]];
  const sliceS = total <= 86400 ? RRM_SLICE_1D_S : RRM_SLICE_1W_S;
  const out = [];
  let end = nowI;
  let left = total;
  while (left > 0) {
    const length = Math.min(sliceS, left);
    const start = end - length;
    out.push([start, end]);
    end = start;
    left -= length;
  }
  return out;
}

export function rrmPagesForBand(band, duration) {
  const short = durationSeconds(duration) <= 6 * 3600;
  if (String(band) === "5") return short ? RRM_PAGES_SHORT_5 : RRM_PAGES_SLICE_5;
  return short ? RRM_PAGES_SHORT_OTHER : RRM_PAGES_SLICE_OTHER;
}

/**
 * Keep distinct correlation IDs.
 *
 * Do not strip trailing timestamps — that collapsed every extra radio-radar / call-radar
 * hit in a 7-day window down to a single card, which looks like the engine failed.
 */
export function dedupeCorrelations(items) {
  const seen = new Set();
  const out = [];
  for (const c of items) {
    const key = String(c.id ?? "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export function asBool(v) {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true" || v === "True") return true;
  if (v === 0 || v === "0" || v === "false" || v === "False") return false;
  return null;
}

export function rssiBand(rssi) {
  if (rssi === null || rssi === undefined) return "unknown";
  if (rssi < -75) return "crit";
  if (rssi < -65) return "warn";
  return "good";
}

export function snrBand(snr) {
  if (snr === null || snr === undefined) return "unknown";
  if (snr < 15) return "crit";
  if (snr < 25) return "warn";
  return "good";
}

export function asRecord(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}

export function uniqueAps(items) {
  const seen = [];
  for (const x of items) {
    const ap = asRecord(x) ? x.ap : "";
    if (ap && !seen.includes(String(ap))) seen.push(String(ap));
  }
  return seen;
}

export function asArray(v) {
  if (Array.isArray(v)) return v.filter((x) => asRecord(x));
  const rec = asRecord(v);
  if (rec && Array.isArray(rec.results)) return rec.results.filter((x) => asRecord(x));
  return [];
}

/**
 * FAIL vs OK for the event timeline.
 *
 * Mist Insights classifies DHCP Success, IP Assigned, DNS Success as positive.
 * CLIENT_IP_ASSIGNED must not be FAIL. Only timed-out / denied / terminated /
 * bad-IP DHCP-DNS-ARP events are negative.
 *
 * Check deauth/disassoc first: CLIENT_DISASSOCIATION contains the letters
 * ASSOCIATION and would otherwise look like a successful join.
 */
export function isNegative(typ, text) {
  const hay = `${typ} ${text}`.toUpperCase();
  if (["DEAUTH", "DISASSOC"].some((k) => hay.includes(k))) return true;
  // AUTH is not a keyword: ASSOCIATION / AUTHORIZATION contain it and would
  // mark every successful join as a failure.
  const success = [
    "SUCCESS", "_OK", " OK", "JOINED", "ASSIGNED",
    "ASSOCIATION", "REASSOCIATION", "AUTHORIZATION",
  ].some((k) => hay.includes(k));
  if (
    success &&
    !["FAIL", "DENIED", "TIMEOUT", "TIMED_OUT", "TERMINATED", "BAD_IP", "BAD IP"].some((k) =>
      hay.includes(k),
    )
  ) {
    return false;
  }
  return NEGATIVE.some((k) => hay.includes(k));
}

/**
 * Normalize occupancy/util to 0-100.
 *
 * radio_stat uses integer percents (1 = 1%). RRM wifi/non_wifi/util_score use
 * 0-1 floats (0.16 = 16%). Treating integer 1 as a fraction painted 100% teal
 * on the serving channel.
 *
 * Python told the two apart by int-vs-float; JSON.parse does not, so RRM
 * occupancy callers pass {fraction:true} to say "a bare 1 here means 1.0".
 */
export function utilPct(v, { fraction = false } = {}) {
  const n = num(v);
  if (n === null) return 0;
  const f = Number(n);
  if (!fraction && Number.isInteger(f)) {
    return Math.trunc(Math.min(100, Math.max(0, f)));
  }
  if (f >= 0 && f <= 1) return Math.trunc(pyRound(f * 100));
  return Math.trunc(pyRound(Math.min(100, Math.max(0, f))));
}

export function mistDeviceId(mac) {
  return `00000000-0000-0000-1000-${hexMac(mac)}`;
}

const SKIP_AP_NAMES = new Set([
  "the", "an", "a", "ap", "the ap", "this ap", "that ap", "another ap",
  "the access point", "access point", "client", "device",
]);

/** Return 12-hex MAC only if the token is actually a MAC, not an AP name with hex letters. */
export function looksLikeMac(raw) {
  const s = String(raw ?? "").trim();
  if (/^(?:[0-9a-fA-F]{2}[:\-]){5}[0-9a-fA-F]{2}$/.test(s)) return hexMac(s);
  if (/^[0-9a-fA-F]{12}$/.test(s)) return s.toLowerCase();
  return "";
}

/** Compare AP names ignoring colons, hyphens, spaces (f0:96:f0 == f096f0). */
export function foldToken(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function cleanApToken(raw) {
  let s = String(raw ?? "").trim().replace(/^["'`]+/, "").replace(/["'`]+$/, "");
  s = s.replace(/[.,;:)]+$/, "");
  s = s.replace(/\s+/g, " ");
  s = s.split(/\s+(?:and|but|which|with|for|on|in)\s+/)[0].trim();
  if (s.length < 3 || SKIP_AP_NAMES.has(s.toLowerCase())) return "";
  return s;
}

/** Last hyphen/underscore segment is often the last 3 MAC octets (f0:96:f0). */
export function nameMacSuffix(name) {
  if (!name) return "";
  const parts = String(name).trim().split(/[-_]/);
  const tail = parts[parts.length - 1];
  const h = hexMac(tail);
  return h.length >= 6 ? h.slice(-6) : h;
}

export function bandGroup(band) {
  const b = String(band ?? "").toLowerCase();
  if (["2", "2.4", "24"].includes(b) || b.includes("2.4")) return "24";
  if (b === "5" || b.includes("5")) return "5";
  if (b === "6" || b.includes("6")) return "6";
  return "unk";
}

/** Python `max(dict, key=dict.get)` — ties go to the first key in insertion order. */
export function argMax(map) {
  let bestKey = null;
  let bestVal = null;
  for (const [k, v] of Object.entries(map)) {
    if (bestKey === null || v > bestVal) {
      bestKey = k;
      bestVal = v;
    }
  }
  return bestKey;
}

/** Portal bar normalization: three components capped to 100% total. */
export function stackPcts(site, external, nonWifi) {
  let s = Math.max(0, site);
  let e = Math.max(0, external);
  const n0 = Math.max(0, nonWifi);
  let n = n0;
  const tot = s + e + n;
  if (tot > 100) {
    s = Math.trunc(pyRound((s * 100) / tot));
    e = Math.trunc(pyRound((e * 100) / tot));
    n = Math.max(0, 100 - s - e);
  }
  return [s, e, n];
}

/**
 * Python str() of a value that epoch_s()/num() produced as a float.
 *
 * Correlation ids and evidence strings interpolate these, and Python renders
 * 1700000000.0 while JS renders 1700000000. Keeping the Python spelling is what
 * makes the golden-file diff against mist_disconnect_console.py come out clean.
 * `epoch_s(x) or 0` collapses a zero float back to int 0, so 0 stays "0".
 */
export function pyFloatStr(v) {
  if (v === null || v === undefined) return "None";
  if (v === 0) return "0";
  return Number.isInteger(v) ? `${v}.0` : String(v);
}
