// Shared test scaffolding: a fetch stub shaped like Mist, and a ctx that gives a
// tool the same surface toolbox.js does.

import { download, safeName, stampedName, toCsv } from "../lib/download.js";
import { epochToUtc, esc, fmtBytes, fmtMac, fmtTime, previewTable } from "../lib/dom.js";
import { getAll, searchAll } from "../lib/paginate.js";
import { STYLE, colLetter, sheet, workbook } from "../lib/xlsx.js";
import { resolveSites } from "../lib/scope.js";
import { POOL_LIMIT, listSites, mistGet, mistGetFull, mistWrite, pool } from "../mist.js";
import { tokenAccess } from "../lib/access.js";

export const HOST = "api.gc2.mist.com";

/**
 * Answer requests from a {pathPrefix: body} routing table. A body may be a
 * function of the URL. Unmatched paths 404, which mistGet reports as absent.
 */
export function stubMist(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    const path = u.pathname.replace(/^\/api\/v1/, "");
    calls.push(path + (u.search || ""));
    // Longest match wins, so route order never matters: a key like
    // "/orgs/x/inventory" must not swallow "/orgs/x/inventory/search".
    const key = Object.keys(routes)
      .filter((k) => path === k || path.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) {
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => "" };
    }
    const r = routes[key];
    const body = typeof r === "function" ? r(u) : r;
    return {
      ok: true,
      status: 200,
      headers: { get: (h) => (h === "X-Page-Total" && Array.isArray(body) ? String(body.length) : null) },
      text: async () => JSON.stringify(body),
    };
  };
  return calls;
}

/** The ctx a tool receives, minus the DOM parts it should not need in tests. */
export function testCtx({ orgId = "org-1", orgName = "Acme Corp", params = {}, role = "read" } = {}) {
  const token = "t".repeat(20);
  const ctl = new AbortController();
  const logs = [];
  const writes = [];
  const paged = { host: HOST, token, signal: ctl.signal };
  return {
    // No token: tools are never given it, exactly as in toolbox.js.
    host: HOST, orgId, orgName, orgs: [{ id: orgId, name: orgName }],
    params, signal: ctl.signal, ctl, logs, writes,
    access: tokenAccess([{ scope: "org", org_id: orgId, role }], orgId),
    // Records each change, then sends it through the real request path.
    mistWrite: (method, path, body, q) => {
      writes.push({ method, path, body });
      return mistWrite(HOST, token, method, path, body, q);
    },
    mistGet: (p, q, t) => mistGet(HOST, token, p, q, t),
    mistGetFull: (p, q, t) => mistGetFull(HOST, token, p, q, t),
    getAll: (p, q, onPage) => getAll({ ...paged, onPage }, p, q),
    searchAll: (p, q, onPage) => searchAll({ ...paged, onPage }, p, q),
    listSites: () => listSites(token, HOST, orgId),
    targetSites: () => resolveSites({ getAll: (p, q) => getAll(paged, p, q), orgId, orgName, params }),
    pool, POOL_LIMIT,
    xlsx: { workbook, sheet, STYLE, colLetter },
    download, stampedName, safeName, toCsv,
    log: (m, k) => logs.push([k || "", m]),
    progress: () => {},
    status: () => {},
    // Same UI surface toolbox.js buildCtx() hands a tool, so a tool that
    // works in tests works in the extension.
    esc, previewTable, fmtMac, fmtTime, epochToUtc, fmtBytes,
  };
}

/** Pull a sheet out of a tool result by name. */
export function sheetNamed(result, name) {
  const s = result.sheets.find((x) => x.name === name);
  if (!s) throw new Error(`no sheet named ${name}; got ${result.sheets.map((x) => x.name).join(", ")}`);
  return s;
}
