// Mist's two pagination regimes, ported from mist_switch_port_inventory.py's
// MistClient.get_paginated / search_paginated.
//
// Getting these wrong truncates reports silently, which is worse than an error,
// so the Python's semantics are reproduced exactly — including the two
// non-obvious ones:
//
//   * A short page does NOT mean the end. Mist routinely returns 100 rows while
//     echoing limit=1000, with the real count only in X-Page-Total.
//   * /search endpoints carry their search_after cursor inside the response's
//     `next` URL, so that URL must be followed verbatim rather than rebuilt.

import { mistGetFull } from "../mist.js";

export const PAGE_LIMIT = 1000;
export const MAX_PAGES = 2000;
const RATE_SLEEP_MS = 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mist wants the lowercase strings, not JS's `true`/`false` coercion. */
export function encodeParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === "boolean" ? (v ? "true" : "false") : v;
  }
  return out;
}

function headerInt(headers, name) {
  if (!headers) return null;
  const raw = headers.get ? headers.get(name) : headers[name];
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number.parseFloat(String(raw).trim());
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Cheap "did this page repeat the last one" check, as in _fingerprint. */
function fingerprint(batch) {
  if (!batch || !batch.length) return "";
  const ident = (item) => (item && typeof item === "object" && !Array.isArray(item)
    ? String(item.mac || item.id || item.port_id || item.serial || item.name || "")
    : String(item));
  const mid = batch[Math.floor(batch.length / 2)];
  return `${batch.length}|${ident(batch[0])}|${ident(mid)}|${ident(batch[batch.length - 1])}`;
}

/**
 * Turn a Mist `next` cursor into the path mistGetFull expects, without ever
 * double-prefixing /api/v1 (resolve_url's job in the Python) and without ever
 * following a cursor to a different host.
 */
export function resolveNext(host, next) {
  const s = String(next || "").trim();
  if (!s) return "";
  const u = /^https?:\/\//i.test(s)
    ? new URL(s)
    : new URL(s.startsWith("/") ? s : `/${s}`, `https://${host}`);
  if (u.hostname !== host) {
    throw new Error("Refusing to follow a pagination cursor to a different host.");
  }
  const path = u.pathname.startsWith("/api/v1") ? u.pathname.slice(7) : u.pathname;
  return `${path}${u.search || ""}`;
}

/**
 * Walk a list endpoint until X-Page-Total rows have been collected.
 * Delegates to searchAll if the endpoint turns out to be a search endpoint.
 *
 * @param {{host: string, token: string, onPage?: (n: number, total: number|null) => void,
 *          signal?: AbortSignal}} ctx
 */
export async function getAll(ctx, path, params = null) {
  const { host, token } = ctx;
  const p = { limit: PAGE_LIMIT, ...encodeParams(params) };
  const requested = Number(p.limit);
  const items = [];
  let prevFp = null;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    if (ctx.signal?.aborted) break;
    const { data, headers } = await mistGetFull(host, token, path, { ...p, page });

    // Some paths answer in the search shape; hand off and keep the cursor logic
    // in one place.
    if (data && typeof data === "object" && !Array.isArray(data)
        && ("results" in data || data.next)) {
      const { page: _drop, ...rest } = p;
      return searchAll(ctx, path, rest);
    }
    if (!Array.isArray(data)) {
      if (data && !items.length) return [data];
      return items;
    }
    if (!data.length) break;

    const fp = fingerprint(data);
    if (fp === prevFp) break;          // the page repeated — stop rather than loop
    prevFp = fp;
    items.push(...data);

    const total = headerInt(headers, "X-Page-Total");
    ctx.onPage?.(items.length, total);
    if (total !== null) {
      if (items.length >= total) break;
    } else if (data.length < requested) {
      break;
    }
    await sleep(RATE_SLEEP_MS);
  }
  return items;
}

/**
 * Walk a /search endpoint by following each response's `next` URL.
 *
 * @param {{host: string, token: string, onPage?: Function, signal?: AbortSignal}} ctx
 */
export async function searchAll(ctx, path, params = null) {
  const { host, token } = ctx;
  const { page: _drop, ...rest } = encodeParams(params);
  const p = { limit: PAGE_LIMIT, ...rest };
  const items = [];
  const seen = new Set();
  let nextPath = null;

  for (let pages = 1; pages <= MAX_PAGES; pages += 1) {
    if (ctx.signal?.aborted) break;
    const { data } = nextPath
      ? await mistGetFull(host, token, nextPath)
      : await mistGetFull(host, token, path, p);

    if (Array.isArray(data)) { items.push(...data); break; }
    if (!data || typeof data !== "object") break;

    let batch = data.results;
    if (batch === null || batch === undefined) {
      if (Array.isArray(data.data)) batch = data.data;
    }
    if (!Array.isArray(batch)) {
      if (!items.length && data && !("results" in data)) return [data];
      break;
    }
    if (!batch.length) break;
    items.push(...batch);

    const total = Number.isFinite(Number(data.total)) && data.total !== null && data.total !== undefined
      ? Math.trunc(Number(data.total)) : null;
    ctx.onPage?.(items.length, total);
    if (total !== null && items.length >= total) break;

    const nxt = data.next ? String(data.next).trim() : "";
    if (!nxt || seen.has(nxt)) break;
    seen.add(nxt);
    nextPath = resolveNext(host, nxt);
    await sleep(RATE_SLEEP_MS);
  }
  return items;
}
