// Ported from mist_disconnect_console.py lines 2487-3072.
//
// This replaces the local ThreadingHTTPServer: MV3 host_permissions give the
// page cross-origin access to the nine Mist regions directly, so there is no
// proxy and the token never leaves this page. It is a function argument here and
// an Authorization header on the wire — nothing more.
//
// Two deliberate departures from the Python:
//   * pool() caps concurrency. fetch_site_rrm_events spawned one OS thread per
//     (band, slice); a 7-day lookback with the adaptive 5 GHz cap is ~670
//     requests, and a bare Promise.all would open all of them at once.
//   * 429 gets bounded exponential backoff before surfacing the same error.

import {
  channelsFromRrm, pickDominantAp, radioFromDevice, servingChannelRow, siteAirtimeByChannel,
} from "./engine/ap.js";
import { pickCall } from "./engine/calls.js";
import { matchInventory } from "./engine/marvis.js";
import {
  asResults, deviceRadioMacs, expandClientAps, pickEvent, pickSession, pickStats,
} from "./engine/normalize.js";
import { annotateRadioEvents, isRadarEvent, radarSessionAlerts } from "./engine/radar.js";
import {
  RadioEventStore, attachApNames, pickRrmEvent, rrmEventsQuery, rrmRowsFrom,
} from "./engine/rrm.js";
import {
  EVENT_PAGES, MIST_HOSTS, RADIO_EVENTS_DURATION, RRM_PAGES_ADAPT_5, RRM_PAGES_LIVE_5,
  RRM_PAGES_LIVE_OTHER, RRM_TIMEOUT, SESSION_PAGES, TIMEOUT,
  asArray, asRecord, durationSeconds, epochS, formatMac, hexMac, mistDeviceId,
  normalizeMac, num, rrmPagesForBand, rrmTimeSlices, utilPct,
} from "./engine/util.js";
import { buildVerdict } from "./engine/verdict.js";

/** Concurrency cap for the RRM scan and the diagnose fan-out. */
export const POOL_LIMIT = 6;
const RETRY_429 = 2;

/**
 * Run `jobs` (thunks returning promises) at most `limit` at a time.
 * Results come back in job order; a rejected job rejects the whole pool, which
 * is what the callers that must not proceed on partial data want.
 */
export async function pool(limit, jobs) {
  const results = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= jobs.length) return;
      results[i] = await jobs[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Error that carries status and endpoint, never headers or the token. */
class MistError extends Error {
  constructor(message, status = null, endpoint = "") {
    super(message);
    this.name = "MistError";
    this.status = status;
    this.endpoint = endpoint;
  }
}

/**
 * GET one Mist path and return the parsed body.
 *
 * Thin wrapper over mistRequest so there is still exactly one fetch in this
 * file — that single call site is the enforcement point for the host allowlist
 * and for credentials: "omit".
 */
export async function mistGet(host, token, path, params = null, timeout = null) {
  return (await mistGetFull(host, token, path, params, timeout)).data;
}

/**
 * Same request, but keeps the response headers. Mist's two pagination regimes
 * both need more than the body: list endpoints report the true row count in
 * X-Page-Total, and /search endpoints carry their cursor in the response.
 */
export async function mistGetFull(host, token, path, params = null, timeout = null) {
  return mistRequest(host, token, "GET", path, { params, timeout });
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Send one change to Mist (POST, PUT, PATCH or DELETE) and return the parsed
 * body. Only tools labelled as making changes are handed this, through
 * ctx.mistWrite. Unlike a GET it is never retried on 429: a retried POST could
 * apply the same change twice.
 */
export async function mistWrite(host, token, method, path, body = null, params = null) {
  const m = String(method || "").toUpperCase();
  if (!WRITE_METHODS.has(m)) {
    throw new MistError(`mistWrite sends POST, PUT, PATCH or DELETE, not "${method}". Use mistGet to read.`);
  }
  return (await mistRequest(host, token, m, path, { params, body })).data;
}

async function mistRequest(host, token, method, path, { params = null, body, timeout = null } = {}) {
  // Enforcement point for the host allowlist, in code. The pages that hold the
  // token also carry a CSP whose connect-src lists only these hosts, so the
  // browser enforces the same rule for code that bypasses this function.
  if (!MIST_HOSTS.includes(host)) throw new MistError("Host is not a known Mist API region.");
  const url = new URL(`https://${host}/api/v1${path}`);
  if (url.protocol !== "https:" || url.hostname !== host) {
    throw new MistError("Refusing a non-HTTPS Mist request.");
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== null && v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const tok = String(token).replace(/token /g, "").replace(/Token /g, "").trim();
  const secs = timeout || TIMEOUT;
  const write = method !== "GET";
  const headers = { Authorization: `Token ${tok}`, Accept: "application/json" };
  if (write && body !== undefined && body !== null) headers["Content-Type"] = "application/json";

  for (let attempt = 0; ; attempt += 1) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), secs * 1000);
    let resp;
    try {
      resp = await fetch(url, {
        method,
        headers,
        ...(write && body !== undefined && body !== null ? { body: JSON.stringify(body) } : {}),
        signal: ctl.signal,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
      });
    } catch (e) {
      clearTimeout(timer);
      // Never re-throw the caught error: its message can embed the request URL.
      if (e && e.name === "AbortError") {
        throw new MistError(`Mist API timed out after ${secs}s.`, null, path);
      }
      throw new MistError("Could not reach the Mist API (network or TLS error).", null, path);
    }
    clearTimeout(timer);

    if (resp.status === 429 && attempt < RETRY_429 && !write) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (resp.ok) {
      if (resp.status === 204) return { data: null, headers: resp.headers, status: 204 };
      const raw = await resp.text();
      return { data: raw ? JSON.parse(raw) : null, headers: resp.headers, status: resp.status };
    }
    if (resp.status === 401) throw new MistError("Token rejected (401). Check region and token.", 401, path);
    if (resp.status === 403) {
      throw new MistError(write
        ? "Your token is not allowed to make this change (403). It may be read-only for this org or site."
        : "Token lacks permission for this org or site (403).", 403, path);
    }
    if (resp.status === 404 && !write) return { data: null, headers: resp.headers, status: 404 };
    if (resp.status === 429) {
      throw new MistError(write
        ? "Mist rate limit (429). The change was not retried, so it was not applied twice; check it and run again."
        : "Mist rate limit (429). Wait a minute and retry.", 429, path);
    }
    const text = (await resp.text()).slice(0, 180);
    throw new MistError(`Mist API ${resp.status}: ${text || resp.statusText}`, resp.status, path);
  }
}

/** GET a list endpoint that may 403/404 when the org lacks the feature (Teams, RRM events). */
export async function fetchOptionalList(host, token, path, params) {
  try {
    return [asResults(await mistGet(host, token, path, params)), null];
  } catch (e) {
    const msg = String(e.message);
    if (msg.includes("400") && ["7d", "1w"].includes(String(params.duration || ""))) {
      const retry = { ...params };
      delete retry.duration;
      retry.start = Math.trunc(Date.now() / 1000) - 7 * 86400;
      try {
        return [asResults(await mistGet(host, token, path, retry)), null];
      } catch (e2) {
        return [[], String(e2.message)];
      }
    }
    return [[], msg];
  }
}

/** One page of listSiteRrmEvents. Returns [rows, hasMore, error]. */
async function rrmEventsPage(host, token, siteId, band, page, start = null, end = null) {
  let params;
  if (start !== null) {
    params = {
      band,
      start: Math.trunc(start),
      end: Math.trunc(end !== null && end !== undefined ? end : Date.now() / 1000),
      limit: 100,
      page: Math.trunc(page),
    };
  } else {
    params = rrmEventsQuery(band, page, 100);
  }
  let payload;
  try {
    payload = await mistGet(host, token, `/sites/${siteId}/rrm/events`, params, RRM_TIMEOUT);
  } catch (e) {
    const msg = String(e.message);
    const low = msg.toLowerCase();
    if (msg.includes("400") && low.includes("band") && low.includes("required")) return [[], false, msg];
    if (msg.includes("400")) {
      const retry = { ...params };
      delete retry.duration;
      if (retry.start === undefined) retry.start = Math.trunc(Date.now() / 1000) - durationSeconds("1d");
      if (retry.end === undefined) retry.end = Math.trunc(Date.now() / 1000);
      try {
        payload = await mistGet(host, token, `/sites/${siteId}/rrm/events`, retry, RRM_TIMEOUT);
      } catch (e2) {
        return [[], false, String(e2.message)];
      }
    } else {
      return [[], false, msg];
    }
  }
  const rows = asResults(payload);
  const rec = asRecord(payload) || {};
  const hasMore = Boolean(rec.next) || rows.length >= 100;
  return [rows, hasMore, null];
}

/**
 * Portal Radio Events for the selected lookback.
 *
 * listSiteRrmEvents cannot filter by AP. We split the window into time slices
 * so a radar storm in the last hour cannot hide a hit from hour 18, then KEEP
 * client-AP rows in the UI export while indexing EVERY scanned radar by AP.
 * A neighbor-radar storm keeps paging (adaptive cap) until the client's AP
 * appears or the slice is exhausted. Live polls only walk the newest hour.
 */
export async function fetchSiteRrmEvents(
  host, token, siteId, duration = "1d", clientAps = null, families = null, live = false,
) {
  const store = new RadioEventStore(clientAps, families);
  const errors = [];
  const slices = rrmTimeSlices(live ? "1h" : duration);

  const pullSlice = async (band, pages, start, end, adapt) => {
    const local = [];
    let err = null;
    const cap = adapt && String(band) === "5" ? RRM_PAGES_ADAPT_5 : pages;
    let clientInSlice = 0;
    for (let page = 1; page <= cap; page += 1) {
      let rows;
      let hasMore;
      [rows, hasMore, err] = await rrmEventsPage(host, token, siteId, band, page, start, end);
      if (err) break;
      local.push(...rows);
      let pageClient = 0;
      for (const raw of rows) {
        const kind = store.add(pickRrmEvent(raw));
        if (kind === "client" || kind === "radar-client") {
          pageClient += 1;
          clientInSlice += 1;
        }
      }
      if (!hasMore) break;
      let oldest = null;
      for (const raw of rows) {
        const ts = epochS(raw.timestamp);
        if (ts === null) continue;
        oldest = oldest === null ? ts : Math.min(oldest, ts);
      }
      if (oldest !== null && oldest < start - 60) break;
      // After the minimum page budget: keep walking only while this page
      // had zero client-AP rows (still inside a neighbor storm). Once
      // client-AP rows appear and then disappear, older pages are noise.
      if (page >= pages && pageClient === 0 && clientInSlice > 0) break;
    }
    if (err && band === "5" && local.length === 0) errors.push(`band=${band}: ${err}`);
  };

  const jobs = [];
  const adapt = !live && durationSeconds(duration) >= 86400;
  for (const [start, end] of slices) {
    const pages5 = live ? RRM_PAGES_LIVE_5 : rrmPagesForBand("5", live ? "1h" : duration);
    jobs.push(() => pullSlice("5", pages5, start, end, adapt));
  }
  if (slices.length) {
    const newest = slices[0];
    const otherPages = live ? RRM_PAGES_LIVE_OTHER : rrmPagesForBand("24", live ? "1h" : duration);
    jobs.push(() => pullSlice("24", otherPages, newest[0], newest[1], false));
    jobs.push(() => pullSlice("6", otherPages, newest[0], newest[1], false));
  }
  await pool(POOL_LIMIT, jobs);

  const uniq = store.exportEvents();
  let err = null;
  if (uniq.length === 0 && errors.length) err = errors.join("; ");
  return [uniq, err, store];
}

export async function mistConnect(token, host) {
  const self = asRecord(await mistGet(host, token, "/self"));
  if (!self) throw new MistError("Empty /self response.");
  const orgs = new Map();
  for (const p of self.privileges || []) {
    if (!asRecord(p)) continue;
    if (p.scope === "org" && typeof p.org_id === "string") {
      orgs.set(p.org_id, String(p.name || p.org_id));
    }
  }
  if (typeof self.org_id === "string" && !orgs.has(self.org_id)) {
    orgs.set(self.org_id, String(self.org_name || self.org_id));
  }
  if (orgs.size === 0) throw new MistError("Token validated but no org privileges were listed.");
  return {
    email: String(self.email || self.name || ""),
    orgs: [...orgs].map(([id, name]) => ({ id, name })),
    // Raw privileges, so the shell can show what this token may do (lib/access.js).
    privileges: asArray(self.privileges).filter((p) => asRecord(p)),
  };
}

export async function listSites(token, host, orgId) {
  // Paged: a single GET stops at Mist's first page, which silently dropped
  // sites from every site picker on a large org. X-Page-Total is the real
  // count when present; a short page is not trusted to mean the end.
  const rows = [];
  for (let page = 1; page <= 200; page += 1) {
    const { data, headers } = await mistGetFull(host, token, `/orgs/${orgId}/sites`, { limit: 1000, page });
    const batch = asArray(data);
    rows.push(...batch);
    const total = Number.parseInt(headers?.get?.("X-Page-Total") ?? "", 10);
    if (!batch.length) break;
    if (Number.isFinite(total) ? rows.length >= total : batch.length < 1000) break;
  }
  const sites = [];
  for (const row of rows) {
    if (typeof row.id === "string") sites.push({ id: row.id, name: String(row.name || row.id) });
  }
  sites.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
  return sites;
}

/** Site AP list (name + mac + id). Prefer stats/devices so radio_stat is already attached. */
export async function listApInventory(token, host, siteId, prefetched = null) {
  let rows = asArray(prefetched);
  if (rows.length === 0) {
    try {
      rows = asArray(await mistGet(host, token, `/sites/${siteId}/devices`, { type: "ap" }));
    } catch {
      rows = [];
    }
  }
  if (rows.length === 0) {
    try {
      rows = asArray(await mistGet(host, token, `/sites/${siteId}/stats/devices`, { type: "ap" }));
    } catch {
      rows = [];
    }
  }
  const out = [];
  const seen = new Set();
  for (const d of rows) {
    const typ = String(d.type || "ap").toLowerCase();
    if (!["ap", "access-point", ""].includes(typ)) continue;
    const mac = hexMac(d.mac);
    const key = mac || String(d.id || d.name || "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/** Resolve AP MAC / UUID / inventory row → stats/devices. */
export async function findDeviceStats(token, host, siteId, apMac, inventory = null, deviceId = "") {
  const inv = inventory || [];
  let did = deviceId;
  if (apMac) {
    const hit = matchInventory(inv, { mac: apMac });
    if (hit) {
      const rec = { ...hit };
      if (rec.id === undefined) rec.id = hit.id || mistDeviceId(apMac);
      if (rec.mac === undefined) rec.mac = apMac;
      if (asRecord(rec.radio_stat)) return rec;
      did = String(rec.id || did);
    }
  }
  did = did || (apMac ? mistDeviceId(apMac) : "");
  let rec = null;
  if (did) {
    rec = asRecord(await mistGet(host, token, `/sites/${siteId}/stats/devices/${did}`));
    if (rec && (!rec.mac || !apMac || hexMac(rec.mac) === hexMac(apMac))) {
      if (rec.id === undefined) rec.id = did;
      return rec;
    }
  }
  if (!apMac) return rec;
  const inv2 = inv.length ? inv : await listApInventory(token, host, siteId);
  const match = matchInventory(inv2, { mac: apMac });
  if (!match) return rec;
  did = String(match.id || mistDeviceId(apMac));
  rec = asRecord(await mistGet(host, token, `/sites/${siteId}/stats/devices/${did}`)) || { ...match };
  if (rec.id === undefined) rec.id = did;
  if (rec.name === undefined) rec.name = match.name ?? null;
  if (rec.mac === undefined) rec.mac = match.mac || apMac;
  return rec;
}

export async function fetchApRadio(token, host, siteId, stats, events, sessions, marvis, inventory = null) {
  const inv = inventory !== null && inventory !== undefined
    ? inventory
    : await listApInventory(token, host, siteId);
  const picked = pickDominantAp(sessions, stats, events, marvis, inv);
  const matched = picked.matchedDev;
  delete picked.matchedDev;
  let apMac = picked.apMac || "";
  if (!apMac && !matched) {
    return {
      ...picked,
      unavailable: "No AP from Marvis, sessions, events, or live stats.",
      channels: [],
      radio: null,
    };
  }
  let dev;
  try {
    if (matched && asRecord(matched.radio_stat)) {
      dev = matched;
    } else {
      dev = await findDeviceStats(token, host, siteId, apMac, inv, String(picked.deviceId || ""));
      if (!dev && matched) dev = matched;
    }
  } catch (e) {
    return { ...picked, unavailable: `AP lookup failed: ${e.message}`, channels: [], radio: null };
  }
  if (!dev) {
    const hint = picked.marvisName || picked.apNameHint || apMac;
    return {
      ...picked,
      unavailable: `AP ${hint || "—"} not found in site inventory.`,
      channels: [],
      radio: null,
    };
  }
  apMac = hexMac(dev.mac) || apMac;
  picked.apMac = apMac;
  const [radioRaw, band] = radioFromDevice(dev, picked.bandHint || "5");
  const servingCh = radioRaw.channel || (stats || {}).channel;
  let rrmRows = [];
  const dids = [];
  for (const cand of [dev.id, picked.deviceId, mistDeviceId(apMac)]) {
    const s = String(cand || "").trim();
    if (s && !dids.includes(s)) dids.push(s);
  }
  try {
    for (const did of dids) {
      const rrm = await mistGet(host, token, `/sites/${siteId}/rrm/current/devices/${did}/band/${band}`);
      rrmRows = rrmRowsFrom(rrm);
      if (rrmRows.length) break;
    }
    // Do not fall back to site-wide channel_scores — those are scores, not
    // per-AP occupancy, and they wipe the orange Site AP bars.
  } catch {
    rrmRows = rrmRows || [];
  }
  const siteCh = siteAirtimeByChannel(inv, band);
  const hasRadio = Object.keys(radioRaw).length > 0;
  let channels = channelsFromRrm(rrmRows, servingCh, hasRadio ? radioRaw : null, band, siteCh);
  if (channels.length === 0 && hasRadio) channels = [servingChannelRow(radioRaw, servingCh)];
  let radio = null;
  if (hasRadio) {
    radio = {
      channel: radioRaw.channel ?? null,
      bandwidth: radioRaw.bandwidth ?? null,
      power: radioRaw.power ?? null,
      numClients: radioRaw.num_clients ?? null,
      utilAll: utilPct(radioRaw.util_all),
      utilTx: utilPct(radioRaw.util_tx),
      utilRxInBss: utilPct(radioRaw.util_rx_in_bss),
      utilRxOtherBss: utilPct(radioRaw.util_rx_other_bss),
      utilNonWifi: utilPct(radioRaw.util_non_wifi),
      utilUnknownWifi: utilPct(radioRaw.util_unknown_wifi),
      utilUndecodable: utilPct(radioRaw.util_undecodable_wifi),
    };
  }
  const status = String(dev.status || (dev.last_seen ? "connected" : "unknown"));
  return {
    ...picked,
    apName: String(dev.name || picked.marvisName || picked.apNameHint || formatMac(apMac)),
    deviceId: String(dev.id || mistDeviceId(apMac)),
    status,
    band,
    radio,
    channels,
    scope: "ap",
    unavailable: radio || channels.length ? null : "No radio_stat or RRM occupancy for this AP.",
    lastSeen: num(dev.last_seen),
  };
}

export async function diagnoseClient({
  token, host, orgId, siteId, siteName, mac: rawMac, duration, live = false,
}) {
  const mac = normalizeMac(rawMac);
  const colon = formatMac(mac);
  const paths = {
    stats: [`/sites/${siteId}/stats/clients/${mac}`, null],
    search: [`/sites/${siteId}/clients/search`, { mac, duration, limit: 20 }],
    events: [
      `/sites/${siteId}/clients/${mac}/events`,
      { duration, limit: ["1d", "1w", "7d"].includes(duration) ? 1000 : 100 },
    ],
    sessions: [`/sites/${siteId}/clients/sessions/search`, { mac, duration, limit: 100 }],
    marvis: [`/orgs/${orgId}/troubleshoot`, { mac: colon, site_id: siteId }],
    aps: [`/sites/${siteId}/devices`, { type: "ap" }],
    devices: [`/sites/${siteId}/stats/devices`, { type: "ap" }],
    calls: [
      `/sites/${siteId}/stats/calls/search`,
      { mac, duration: RADIO_EVENTS_DURATION, limit: 50 },
    ],
  };
  const got = {};
  const errors = {};
  const keys = Object.keys(paths);
  await pool(
    POOL_LIMIT,
    keys.map((k) => async () => {
      const [p, q] = paths[k];
      try {
        got[k] = await mistGet(host, token, p, q);
      } catch (e) {
        errors[k] = String(e.message);
      }
    }),
  );
  for (const key of ["stats", "search", "events"]) {
    const msg = (errors[key] || "").toLowerCase();
    if (["401", "403", "rate limit", "timed out"].some((x) => msg.includes(x))) {
      throw new MistError(errors[key]);
    }
  }

  let stats = null;
  const rec = asRecord(got.stats);
  if (rec && rec.mac) stats = pickStats(rec);
  else if (asArray(got.stats).length) stats = pickStats(asArray(got.stats)[0]);
  const sightings = asArray(got.search).map((r) => pickStats(r));
  if (!stats && sightings.length) stats = sightings[0];

  const events = asArray(got.events).map((r) => pickEvent(r));
  let evPage = 2;
  const evLimit = ["1d", "1w", "7d"].includes(duration) ? 1000 : 100;
  // Walk older pages when the 7-day client log is larger than one response.
  let oldest = events.length ? Math.min(...events.map((e) => e.timestamp || 0)) : 0;
  const windowStart = Math.trunc(Date.now() / 1000) - durationSeconds(duration);
  while (evPage <= EVENT_PAGES && events.length && oldest > windowStart + 30) {
    let [extra] = await fetchOptionalList(host, token, `/sites/${siteId}/clients/${mac}/events`, {
      start: windowStart, end: Math.trunc(oldest) - 1, limit: evLimit,
    });
    if (!extra.length) {
      [extra] = await fetchOptionalList(host, token, `/sites/${siteId}/clients/${mac}/events`, {
        duration, limit: 100, page: evPage,
      });
    }
    if (!extra.length) break;
    const before = new Set(events.map((e) => JSON.stringify([e.timestamp, e.type, e.ap])));
    let added = 0;
    for (const r of extra) {
      const ev = pickEvent(r);
      const key = JSON.stringify([ev.timestamp, ev.type, ev.ap]);
      if (before.has(key)) continue;
      events.push(ev);
      added += 1;
    }
    if (!added) break;
    oldest = Math.min(...events.map((e) => e.timestamp || 0));
    evPage += 1;
  }
  events.sort((a, b) => b.timestamp - a.timestamp);

  let sessions = (asResults(got.sessions).length ? asResults(got.sessions) : asArray(got.sessions))
    .map((r) => pickSession(r));
  let page = 2;
  while (sessions.length >= 100 * (page - 1) && page <= SESSION_PAGES) {
    const [extra] = await fetchOptionalList(host, token, `/sites/${siteId}/clients/sessions/search`, {
      mac, duration, limit: 100, page,
    });
    if (!extra.length) break;
    sessions.push(...extra.map((r) => pickSession(r)));
    if (extra.length < 100) break;
    page += 1;
  }
  const seenSess = new Set();
  const uniqSess = [];
  for (const s of sessions) {
    const key = JSON.stringify([hexMac(s.ap), s.connect, s.disconnect]);
    if (seenSess.has(key)) continue;
    seenSess.add(key);
    uniqSess.push(s);
  }
  sessions = uniqSess;
  sessions.sort((a, b) => (b.connect || 0) - (a.connect || 0));

  let marvisRaw = null;
  let marvisText = null;
  let marvisUnavail = false;
  if ("marvis" in errors) {
    marvisUnavail = true;
  } else {
    const v = got.marvis;
    if (v === null || v === undefined) marvisUnavail = true;
    else {
      marvisRaw = v;
      marvisText = typeof v === "string" ? v : JSON.stringify(v, null, 2);
    }
  }

  const inventory = await listApInventory(token, host, siteId, got.devices || got.aps);
  if (got.aps) {
    // Merge names/macs from the lighter devices list onto stats rows.
    const byMac = new Map();
    for (const d of inventory) {
      const h = hexMac(d.mac);
      if (h) byMac.set(h, d);
    }
    for (const d of asArray(got.aps)) {
      const m = hexMac(d.mac);
      if (m && byMac.has(m)) {
        const target = byMac.get(m);
        if (d.name && !target.name) target.name = d.name;
        if (d.id && !target.id) target.id = d.id;
      } else if (m) {
        inventory.push(d);
      }
    }
  }
  attachApNames(sessions, inventory);
  const clientAps = expandClientAps(sessions, events, stats, inventory);
  const families = inventory.map((d) => deviceRadioMacs(d)).filter((f) => f.size > 0);

  const [apRadioSettled, rrmSettled] = await Promise.all([
    (async () => {
      try {
        return await fetchApRadio(
          token, host, siteId, stats, events, sessions,
          marvisRaw !== null && marvisRaw !== undefined ? marvisRaw : marvisText,
          inventory,
        );
      } catch (e) {
        return {
          unavailable: String(e.message), channels: [], radio: null,
          apMac: hexMac((stats || {}).ap),
        };
      }
    })(),
    fetchSiteRrmEvents(host, token, siteId, duration, clientAps, families, live),
  ]);
  const apRadio = apRadioSettled;
  let [radioEvents, radioUnavail] = rrmSettled;
  const radioStore = rrmSettled[2];
  radioEvents = attachApNames(radioEvents, inventory);
  radioEvents = annotateRadioEvents(radioEvents, events, sessions, stats);
  const clientRadar = radioStore.clientRadarEvents(sessions);
  const clientKeys = new Set(clientRadar.map((e) => JSON.stringify([e.ap, e.timestamp, e.event])));
  for (const re of radioEvents) {
    if (clientKeys.has(JSON.stringify([re.ap, re.timestamp, re.event]))) {
      re.onClientAp = true;
      if (isRadarEvent(re)) re.highlight = true;
    }
  }
  for (const re of clientRadar) {
    re.onClientAp = true;
    re.highlight = true;
  }

  let calls = asResults(got.calls).map((r) => pickCall(r));
  let callsUnavail = errors.calls ?? null;
  if (callsUnavail && !calls.length) {
    const [extra, err2] = await fetchOptionalList(host, token, `/sites/${siteId}/stats/calls/search`, {
      mac, duration: RADIO_EVENTS_DURATION, limit: 50,
    });
    calls = extra.map((r) => pickCall(r));
    callsUnavail = calls.length ? null : err2 || callsUnavail;
  }
  calls.sort((a, b) => (b.start || 0) - (a.start || 0));
  const radarAlerts = radarSessionAlerts(radioEvents, sessions, calls, apRadio, radioStore);

  const lastSeen = (stats || {}).lastSeen;
  const online = Boolean(
    lastSeen !== null && lastSeen !== undefined && Date.now() / 1000 - Number(lastSeen) < 300,
  );
  return {
    demo: false,
    host,
    orgId,
    siteId,
    siteName,
    mac,
    duration,
    online,
    stats,
    sightings,
    events,
    sessions,
    marvisText,
    marvisUnavailable: marvisUnavail,
    apRadio,
    radioEvents,
    radioEventsUnavailable: radioUnavail,
    clientRadarEvents: clientRadar,
    calls,
    callsUnavailable: callsUnavail,
    radarAlerts,
    radioStoreStats: {
      scanned: radioStore.scanned,
      dropped: radioStore.dropped,
      radars: radioStore.radars.length,
      kept: radioStore.kept.length,
      clientHits: clientRadar.length,
    },
    verdict: buildVerdict(stats, events, sessions, apRadio, radioEvents, calls, radioStore),
    fetchedAt: Math.trunc(Date.now()),
  };
}
