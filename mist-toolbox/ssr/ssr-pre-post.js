// Ported from pre-post-check-gui.py.
//
// Not a Mist tool: it talks to a Juniper SSR (128T) Conductor at a host only the
// user knows, so it owns its credentials, its host permission and its own fetch.
// This is the one file where POST is allowed, and only for two things — the
// login exchange, and the session-count endpoint the Conductor answers only to
// POST. Nothing here changes router configuration.
//
// Three capabilities of the Python do not survive the browser, and the UI says
// so rather than implying otherwise:
//
//   * verify=False and the CA-bundle picker. fetch() offers no way to skip
//     certificate verification. On a TLS failure the tool explains how to trust
//     the certificate once, with a link, and offers a retry.
//   * The workdir. The Python wrote {router}-{pre|post}-{key}-{ts}.json into a
//     folder and re-read the newest `pre` file later. Snapshots are held in
//     memory for a same-session pre -> post, and can be downloaded and reloaded
//     for a change window that outlives the tab. No storage API is touched.
//   * _secure_erase's ctypes.memset. JS strings are immutable and cannot be
//     scrubbed; the password is dropped from the field once exchanged.

import { changedLines, diffText, toCliText } from "../lib/cliview.js";
import { charDiff, computeChanges } from "../lib/diff.js";

/** The nine checks, verbatim from the Python's CHECKS registry. */
export const CHECKS = {
  bgp_summary: ["BGP Summary", "router_get", "/api/v1/router/{r}/bgp?command=summary"],
  ospf_neighbors: ["OSPF Neighbors", "router_get", "/api/v1/router/{r}/ospf?command=neighbor"],
  network_interfaces: ["Network Interfaces", "node_get", "/api/v1/router/{r}/node/{n}/networkInterface"],
  device_interfaces: ["Device Interfaces", "node_get", "/api/v1/router/{r}/node/{n}/deviceInterface"],
  peer_detail: ["Peer / Adjacency Detail", "node_get", "/api/v1/router/{r}/node/{n}/adjacency"],
  node_status: ["Node Status", "node_get", "/api/v1/router/{r}/node/{n}/status"],
  node_version: ["Node Version", "node_get", "/api/v1/router/{r}/node/{n}/version"],
  aggregate_sessions: ["Aggregate Sessions", "router_post",
    "/api/v1/router/{r}/stats/aggregate-session/node/session-count"],
  active_alarms: ["Active Alarms", "router_get", "/api/v1/router/{r}/alarm"],
};

const SNAPSHOT_KIND = "ssr-pre-post-snapshot";
const TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 60_000;

/** Normalise whatever the user typed into an https origin. */
export function normalizeBaseUrl(input) {
  // Check for emptiness before touching trailing slashes: stripping first turns
  // a bare "https://" into "https:", which then parses as a host named https.
  const raw = String(input || "").trim();
  if (!raw || /^https?:\/*$/i.test(raw)) throw new Error("Enter the Conductor URL.");
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error(`"${input}" is not a valid URL.`);
  }
  if (u.protocol !== "https:") throw new Error("The Conductor must be reached over HTTPS.");
  if (!u.hostname || !/^[A-Za-z0-9.-]+$/.test(u.hostname)) {
    throw new Error(`"${input}" is not a valid Conductor host.`);
  }
  return u.origin;
}

class SsrError extends Error {
  constructor(message, { tls = false, status = null } = {}) {
    super(message);
    this.name = "SsrError";
    this.tls = tls;
    this.status = status;
  }
}

/**
 * One Conductor request. `method` is GET except for the login exchange and the
 * session-count endpoint.
 */
async function ssrFetch(baseUrl, endpoint, { token = "", method = "GET", body = null, timeout = TIMEOUT_MS, signal } = {}) {
  const url = new URL(endpoint, baseUrl);
  if (url.origin !== baseUrl) throw new SsrError("Refusing a request to a different host.");

  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
  } catch (e) {
    if (signal?.aborted) throw new SsrError("Cancelled.");
    if (e && e.name === "AbortError") throw new SsrError(`The Conductor did not answer within ${timeout / 1000}s.`);
    // A rejected certificate and an unreachable host look identical here, so
    // the message has to cover both.
    throw new SsrError("Could not reach the Conductor (network error, or its certificate is not trusted).", { tls: true });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new SsrError(`The Conductor rejected the request (${resp.status}). Check the credentials.`, { status: resp.status });
  }
  if (!resp.ok) {
    const text = (await resp.text().catch(() => "")).slice(0, 300);
    throw new SsrError(`Conductor returned ${resp.status}: ${text || resp.statusText}`, { status: resp.status });
  }
  const raw = await resp.text();
  return raw ? JSON.parse(raw) : null;
}

/** authenticate(): POST /api/v1/login, token from `token` or `sessionToken`. */
export async function authenticate(baseUrl, username, password, signal) {
  const data = await ssrFetch(baseUrl, "/api/v1/login", {
    method: "POST",
    body: { username, password },
    timeout: LOGIN_TIMEOUT_MS,
    signal,
  });
  const token = data && (data.token || data.sessionToken);
  if (!token) throw new SsrError("Login succeeded but returned no token.");
  return token;
}

/** collect_check(): one check for one router, fanning out per node where needed. */
export async function collectCheck(baseUrl, token, router, nodes, key, signal) {
  const [, etype, tpl] = CHECKS[key];
  const path = (n) => tpl.replace("{r}", encodeURIComponent(router))
    .replace("{n}", encodeURIComponent(n ?? ""));
  if (etype === "router_get") return ssrFetch(baseUrl, path(), { token, signal });
  if (etype === "router_post") return ssrFetch(baseUrl, path(), { token, method: "POST", signal });
  if (etype === "node_get") {
    const out = {};
    for (const n of nodes) out[n] = await ssrFetch(baseUrl, path(n), { token, signal });
    return out;
  }
  throw new Error(`Unknown endpoint type: ${etype}`);
}

/** Routers and their nodes, from GET /api/v1/asset?verbose=false. */
export function routerNodesFromAssets(assets) {
  const map = new Map();
  for (const a of Array.isArray(assets) ? assets : []) {
    if (!a || typeof a !== "object") continue;
    const router = a.routerName;
    if (!router) continue;
    if (!map.has(router)) map.set(router, []);
    const node = a.nodeName;
    if (node && !map.get(router).includes(node)) map.get(router).push(node);
  }
  return map;
}

export default {
  id: "ssr-pre-post",
  name: "SSR Pre/Post Check",
  description: "Snapshot BGP, OSPF, interfaces, adjacencies, node status, sessions and alarms "
    + "across an SSR Conductor's routers before a change, then again after, and diff every "
    + "value that moved.",
  tag: "SSR Conductor · not Mist",
  level: "SSR Conductor",
  needs: { mistToken: false },

  async mount(ctx) {
    const { esc } = ctx;
    const state = {
      baseUrl: "", token: "", routerNodes: new Map(),
      checks: new Set(Object.keys(CHECKS)),
      routers: new Set(),
      pre: null,          // { baseUrl, takenAt, data: {router: {key: payload}} }
      post: null,         // { takenAt, data } from the latest post-check
      diff: null,
      ctl: null,
      busy: false,
    };

    ctx.mount.innerHTML = `
      <div class="stack">
        <div class="card" id="ssrConnectCard">
          <h2 style="font-size:1.05rem;margin:0 0 .3rem">Connect to the Conductor</h2>
          <p class="subtle" style="font-size:12px;margin:0 0 1rem">
            Credentials are exchanged for a bearer token and held in memory for this tab only.
            Unlike the desktop script, a browser cannot skip certificate verification or load a
            CA bundle, and it cannot scrub the password from memory afterwards.
          </p>
          <div class="params" id="ssrForm">
            <label class="full"><span>Conductor URL</span>
              <input id="ssrUrl" type="text" placeholder="https://conductor.example.com" spellcheck="false"/></label>
            <label><span>Username</span>
              <input id="ssrUser" type="text" autocomplete="off" spellcheck="false"/></label>
            <label><span>Password</span>
              <input id="ssrPass" type="password" autocomplete="new-password" spellcheck="false"/></label>
          </div>
          <div class="actions" style="margin-top:1rem">
            <button class="btn btn-p" id="ssrConnect" type="button">Connect</button>
            <span class="muted" id="ssrConnStatus" style="font-size:13px"></span>
          </div>
          <div id="ssrCertHelp" class="hidden" style="margin-top:1rem"></div>
        </div>

        <div class="card hidden" id="ssrScopeCard">
          <div class="row" style="flex-wrap:wrap;gap:.5rem">
            <h2 style="font-size:1.05rem;margin:0">Scope</h2>
            <span class="muted" id="ssrScopeSub" style="font-size:13px"></span>
          </div>
          <div class="grid2" style="margin-top:1rem">
            <div>
              <div class="row"><strong style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--subtle)">Routers</strong>
                <span class="chiprow"><button class="chip" id="ssrAll" type="button">All</button><button class="chip" id="ssrNone" type="button">None</button></span></div>
              <div class="res-scroll" id="ssrRouters" style="margin-top:.5rem;max-height:18rem"></div>
            </div>
            <div>
              <strong style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--subtle)">Checks</strong>
              <div id="ssrChecks" style="margin-top:.5rem"></div>
            </div>
          </div>
          <div class="actions" style="margin-top:1.1rem">
            <button class="btn btn-p" id="ssrPre" type="button">Run pre-check</button>
            <button class="btn btn-s" id="ssrPost" type="button" disabled>Run post-check &amp; diff</button>
            <button class="btn btn-s hidden" id="ssrCancel" type="button">Cancel</button>
            <span class="muted" id="ssrRunStatus" style="font-size:13px"></span>
          </div>
          <div class="bar hidden" id="ssrBarWrap" style="margin-top:.9rem"><i id="ssrBar"></i></div>
          <div class="actions" style="margin-top:1rem">
            <button class="btn btn-g" id="ssrSave" type="button" disabled>Download pre-check snapshot</button>
            <label class="btn btn-g" for="ssrLoad" style="cursor:pointer">Load pre-check snapshot
              <input id="ssrLoad" type="file" accept="application/json,.json" style="display:none"/></label>
          </div>
          <p class="subtle" style="font-size:12px;margin:.6rem 0 0" id="ssrPreState">
            No pre-check snapshot yet.
          </p>
        </div>

        <div class="card hidden" id="ssrLogCard">
          <strong style="font-size:13px">Activity</strong>
          <div class="log mono" id="ssrLog"></div>
        </div>

        <div class="card hidden" id="ssrOutCard">
          <div class="row" style="flex-wrap:wrap;gap:.6rem">
            <strong id="ssrOutTitle" style="font-size:13px">Output</strong>
            <div class="actions">
              <select id="ssrOutRouter" aria-label="Router" style="min-width:12rem;width:auto"></select>
              <select id="ssrOutMode" aria-label="View" style="width:auto">
                <option value="post">Post-check, changes highlighted</option>
                <option value="side">Pre and post, side by side</option>
              </select>
              <label class="check" style="min-height:auto"><input type="checkbox" id="ssrOutChanged"/>
                <span style="margin:0;text-transform:none;letter-spacing:0;font-size:13px;color:var(--fg)">Changed checks only</span></label>
            </div>
          </div>
          <div class="legend" id="ssrOutLegend"></div>
          <div id="ssrOutBody"></div>
        </div>

        <div class="card hidden" id="ssrDiffCard">
          <div class="row" style="flex-wrap:wrap;gap:.6rem">
            <strong id="ssrDiffTitle" style="font-size:13px"></strong>
            <div class="actions">
              <input id="ssrFilter" type="text" placeholder="filter path or value" style="min-width:14rem"/>
              <button class="btn btn-s" id="ssrCsv" type="button">Export CSV</button>
            </div>
          </div>
          <div id="ssrDiffBody" style="margin-top:.8rem"></div>
        </div>
      </div>`;

    const $$ = (id) => ctx.mount.querySelector(`#${id}`);
    const log = (msg, kind = "") => {
      const el = $$("ssrLog");
      const line = document.createElement("div");
      if (kind) line.className = kind;
      line.textContent = msg;
      el.appendChild(line);
      el.scrollTop = el.scrollHeight;
      $$("ssrLogCard").classList.remove("hidden");
    };
    const bar = (done, total) => {
      $$("ssrBarWrap").classList.remove("hidden");
      $$("ssrBar").style.width = total ? `${Math.round((done / total) * 100)}%` : "0";
      $$("ssrRunStatus").textContent = `${done}/${total}`;
    };

    // ---- Checks list -----------------------------------------------------
    $$("ssrChecks").innerHTML = Object.entries(CHECKS).map(([key, [label]]) => `
      <div class="check">
        <input id="chk_${esc(key)}" type="checkbox" data-check="${esc(key)}" checked/>
        <label for="chk_${esc(key)}" style="margin:0">${esc(label)}</label>
      </div>`).join("");
    $$("ssrChecks").querySelectorAll("[data-check]").forEach((el) => {
      el.onchange = () => {
        const k = el.getAttribute("data-check");
        if (el.checked) state.checks.add(k); else state.checks.delete(k);
      };
    });

    function renderRouters() {
      const names = [...state.routerNodes.keys()].sort();
      $$("ssrRouters").innerHTML = names.map((r) => {
        const nodes = state.routerNodes.get(r);
        return `<div class="check">
          <input id="rtr_${esc(r)}" type="checkbox" data-router="${esc(r)}" ${state.routers.has(r) ? "checked" : ""}/>
          <label for="rtr_${esc(r)}" style="margin:0">${esc(r)}
            <span class="subtle" style="font-size:12px"> ${esc(nodes.length)} node${nodes.length === 1 ? "" : "s"}</span>
          </label>
        </div>`;
      }).join("") || '<p class="muted">No routers reported.</p>';
      $$("ssrRouters").querySelectorAll("[data-router]").forEach((el) => {
        el.onchange = () => {
          const r = el.getAttribute("data-router");
          if (el.checked) state.routers.add(r); else state.routers.delete(r);
          updateScopeSub();
        };
      });
      updateScopeSub();
    }
    function updateScopeSub() {
      $$("ssrScopeSub").textContent = `${state.routers.size} of ${state.routerNodes.size} router(s), `
        + `${state.checks.size} check(s) selected`;
    }
    $$("ssrAll").onclick = () => {
      state.routers = new Set(state.routerNodes.keys());
      renderRouters();
    };
    $$("ssrNone").onclick = () => { state.routers = new Set(); renderRouters(); };

    // ---- Connect ---------------------------------------------------------
    $$("ssrConnect").onclick = async () => {
      $$("ssrCertHelp").classList.add("hidden");
      $$("ssrConnStatus").textContent = "";
      const btn = $$("ssrConnect");
      btn.disabled = true;
      let password = $$("ssrPass").value;
      try {
        const baseUrl = normalizeBaseUrl($$("ssrUrl").value);
        const username = $$("ssrUser").value.trim();
        if (!username) throw new Error("Enter a username.");
        if (!password) throw new Error("Enter a password.");

        // The Conductor host is not in host_permissions; ask for just this one
        // origin, from this click.
        const origins = [`${baseUrl}/*`];
        const already = await chrome.permissions.contains({ origins });
        if (!already) {
          const granted = await chrome.permissions.request({ origins });
          if (!granted) throw new Error(`Access to ${baseUrl} was not granted.`);
        }

        $$("ssrConnStatus").textContent = "Authenticating…";
        state.token = await authenticate(baseUrl, username, password, undefined);
        state.baseUrl = baseUrl;
        // Nothing else should hold the password.
        $$("ssrPass").value = "";
        password = "";

        $$("ssrConnStatus").textContent = "Discovering routers…";
        const assets = await ssrFetch(baseUrl, "/api/v1/asset?verbose=false", { token: state.token });
        state.routerNodes = routerNodesFromAssets(assets);
        if (!state.routerNodes.size) throw new Error("The Conductor reported no routers.");
        state.routers = new Set(state.routerNodes.keys());

        $$("ssrConnStatus").textContent = `Connected to ${baseUrl}`;
        log(`Connected to ${baseUrl}; ${state.routerNodes.size} router(s).`, "ok");
        $$("ssrScopeCard").classList.remove("hidden");
        renderRouters();
      } catch (err) {
        $$("ssrConnStatus").textContent = "";
        log(err.message, "err");
        if (err instanceof SsrError && err.tls) {
          showCertHelp();
        } else {
          $$("ssrCertHelp").innerHTML = `<div class="alert">${esc(err.message)}</div>`;
          $$("ssrCertHelp").classList.remove("hidden");
        }
      } finally {
        btn.disabled = false;
      }
    };

    function showCertHelp() {
      let origin = "";
      try { origin = normalizeBaseUrl($$("ssrUrl").value); } catch { origin = ""; }
      $$("ssrCertHelp").innerHTML = `
        <div class="alert" style="color:var(--warn);border-color:color-mix(in oklab,var(--warn) 45%,var(--border))">
          <strong>Could not reach the Conductor.</strong>
          <p style="margin:.5rem 0 0">
            The desktop script skipped certificate checks (<code>verify=False</code>); a browser
            extension cannot. If this Conductor uses a self-signed or internal-CA certificate,
            open it in a tab once, accept the certificate, then come back and press Connect again.
          </p>
          ${origin ? `<p style="margin:.6rem 0 0"><a href="${esc(origin)}" target="_blank" rel="noopener" class="accent">Open ${esc(origin)} in a new tab</a></p>` : ""}
          <p class="subtle" style="font-size:12px;margin:.6rem 0 0">
            If the host or port is simply wrong or unreachable, the error looks identical — the
            browser does not tell the page which it was.
          </p>
        </div>`;
      $$("ssrCertHelp").classList.remove("hidden");
    }

    // ---- Run -------------------------------------------------------------
    async function runPass(suffix) {
      if (state.busy) return;
      const routers = [...state.routers].sort();
      const checks = [...state.checks].filter((k) => k in CHECKS);
      if (!routers.length) { log("Select at least one router.", "err"); return; }
      if (!checks.length) { log("Select at least one check.", "err"); return; }
      if (suffix === "post" && !state.pre) { log("Run or load a pre-check first.", "err"); return; }

      state.busy = true;
      state.ctl = new AbortController();
      $$("ssrPre").disabled = true;
      $$("ssrPost").disabled = true;
      $$("ssrCancel").classList.remove("hidden");
      $$("ssrLog").innerHTML = "";

      const total = routers.length * checks.length;
      let done = 0;
      const data = {};
      try {
        for (const router of routers) {
          if (state.ctl.signal.aborted) break;
          data[router] = {};
          const nodes = state.routerNodes.get(router) || [];
          for (const key of checks) {
            if (state.ctl.signal.aborted) break;
            const [label] = CHECKS[key];
            try {
              data[router][key] = await collectCheck(
                state.baseUrl, state.token, router, nodes, key, state.ctl.signal,
              );
              log(`${router} / ${label}: ok`, "ok");
            } catch (e) {
              log(`${router} / ${label}: ${e.message}`, "err");
            }
            done += 1;
            bar(done, total);
          }
        }

        if (state.ctl.signal.aborted) { $$("ssrRunStatus").textContent = "Cancelled."; return; }

        if (suffix === "pre") {
          state.pre = { baseUrl: state.baseUrl, takenAt: new Date().toISOString(), data };
          state.post = null;
          state.diff = null;
          $$("ssrDiffCard").classList.add("hidden");
          renderOutput();
          $$("ssrPost").disabled = false;
          $$("ssrSave").disabled = false;
          setPreState();
          log("Pre-check captured. Make the change, then run the post-check.", "ok");
        } else {
          const diff = {};
          for (const router of routers) {
            diff[router] = {};
            for (const key of checks) {
              const pre = state.pre.data?.[router]?.[key];
              const post = data[router]?.[key];
              if (pre === undefined || post === undefined) continue;
              diff[router][key] = computeChanges(pre, post, key);
            }
          }
          state.diff = diff;
          state.post = { takenAt: new Date().toISOString(), data };
          renderDiff();
          renderOutput();
          const n = countChanges(diff);
          log(`Post-check complete: ${n} change(s).`, n ? "err" : "ok");
          $$("ssrRunStatus").textContent = `${n} change(s)`;
        }
      } finally {
        state.busy = false;
        $$("ssrPre").disabled = false;
        $$("ssrPost").disabled = !state.pre;
        $$("ssrCancel").classList.add("hidden");
      }
    }

    const countChanges = (diff) => Object.values(diff)
      .flatMap((byCheck) => Object.values(byCheck)).reduce((n, rows) => n + rows.length, 0);

    function setPreState() {
      $$("ssrPreState").textContent = state.pre
        ? `Pre-check snapshot from ${new Date(state.pre.takenAt).toLocaleString()}`
          + ` covering ${Object.keys(state.pre.data).length} router(s).`
          + " Download it if the change window outlives this tab."
        : "No pre-check snapshot yet.";
    }

    $$("ssrPre").onclick = () => runPass("pre");
    $$("ssrPost").onclick = () => runPass("post");
    $$("ssrCancel").onclick = () => { state.ctl?.abort(); $$("ssrRunStatus").textContent = "Cancelling…"; };

    // ---- Snapshot download / load ----------------------------------------
    $$("ssrSave").onclick = () => {
      if (!state.pre) return;
      const payload = { kind: SNAPSHOT_KIND, version: 1, ...state.pre };
      const name = ctx.stampedName("ssr_precheck", new URL(state.baseUrl).hostname, "json");
      ctx.download(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), name);
      log(`Saved ${name} to your downloads.`, "ok");
    };

    $$("ssrLoad").onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        if (parsed?.kind !== SNAPSHOT_KIND || !parsed.data || typeof parsed.data !== "object") {
          throw new Error("That is not a pre-check snapshot from this tool.");
        }
        state.pre = { baseUrl: parsed.baseUrl || "", takenAt: parsed.takenAt || "", data: parsed.data };
        $$("ssrPost").disabled = !state.baseUrl;
        $$("ssrSave").disabled = false;
        state.post = null;
        setPreState();
        renderOutput();
        log(`Loaded a pre-check snapshot covering ${Object.keys(parsed.data).length} router(s).`, "ok");
        if (parsed.baseUrl && state.baseUrl && parsed.baseUrl !== state.baseUrl) {
          log(`Note: that snapshot came from ${parsed.baseUrl}, not ${state.baseUrl}.`, "err");
        }
      } catch (err) {
        log(err.message, "err");
      } finally {
        e.target.value = "";
      }
    };

    // ---- Diff view -------------------------------------------------------
    function diffRows() {
      const out = [];
      for (const [router, byCheck] of Object.entries(state.diff || {})) {
        for (const [key, rows] of Object.entries(byCheck)) {
          for (const r of rows) out.push({ router, check: CHECKS[key]?.[0] || key, ...r });
        }
      }
      return out;
    }

    function renderDiff() {
      const rows = diffRows();
      $$("ssrDiffCard").classList.remove("hidden");
      $$("ssrDiffTitle").textContent = `${rows.length} change(s)`;
      const filter = $$("ssrFilter").value.trim().toLowerCase();
      const shown = filter
        ? rows.filter((r) => `${r.router} ${r.check} ${r.path} ${r.pre} ${r.post}`.toLowerCase().includes(filter))
        : rows;

      if (!rows.length) {
        $$("ssrDiffBody").innerHTML = '<p class="good" style="margin:0">Nothing changed between the pre and post captures.</p>';
        return;
      }
      $$("ssrDiffBody").innerHTML = `
        <div class="res-scroll"><table class="ap-table">
          <thead><tr><th>Router</th><th>Check</th><th>Path</th><th>Pre</th><th>Post</th><th>Change</th></tr></thead>
          <tbody>${shown.map((r, i) => `<tr data-row="${i}" style="cursor:pointer">
            <td>${esc(r.router)}</td><td>${esc(r.check)}</td>
            <td class="mono break">${esc(r.path || "(output)")}</td>
            <td><div class="cellval">${esc(r.pre)}</div></td>
            <td><div class="cellval">${esc(r.post)}</div></td>
            <td class="${r.change === "Added" ? "good" : r.change === "Removed" ? "crit" : "warn"}">${esc(r.change)}</td>
          </tr>`).join("")}</tbody>
        </table></div>
        <div id="ssrDetail" style="margin-top:.8rem"></div>`;
      $$("ssrDiffBody").querySelectorAll("[data-row]").forEach((tr) => {
        tr.onclick = () => showDetail(shown[Number(tr.getAttribute("data-row"))]);
      });
    }

    function showDetail(row) {
      const detail = ctx.mount.querySelector("#ssrDetail");
      const head = `<div class="row"><strong style="font-size:13px">${esc(row.router)} · ${esc(row.check)}</strong>
            <span class="pill">${esc(row.change)}</span></div>
          <p class="mono subtle break" style="font-size:12px;margin:.4rem 0 .8rem">${esc(row.path || "(output)")}</p>`;
      if (String(row.pre).includes("\n") || String(row.post).includes("\n")) {
        // Multi-line CLI text: a line/field diff reads far better than characters.
        detail.innerHTML = `<div class="card" style="background:var(--surface-2)">${head}
          ${sideBySide(diffText(cleanCli(row.pre), cleanCli(row.post)))}</div>`;
      } else {
        const [pre, post] = charDiff(row.pre, row.post);
        detail.innerHTML = `<div class="card" style="background:var(--surface-2)">${head}
          <dl><dt>Pre</dt><dd class="cellval full">${segHtml(pre, "del") || '<span class="subtle">(empty)</span>'}</dd>
              <dt>Post</dt><dd class="cellval full">${segHtml(post, "hot") || '<span class="subtle">(empty)</span>'}</dd></dl>
        </div>`;
      }
      detail.scrollIntoView({ block: "nearest" });
    }

    // ---- Terminal-style output -------------------------------------------
    const cleanCli = (v) => toCliText(String(v ?? ""));
    const lineText = (segs) => (segs || []).map(([t]) => t).join("");
    const segHtml = (segs, cls) => (segs || []).map(([t, hot]) => (hot
      ? `<mark class="${cls}">${esc(t)}</mark>` : esc(t))).join("");

    /** Post-check as the terminal would show it, changes marked in place. */
    function postView(rows) {
      return `<div class="term"><div class="term-in">${rows.map((r) => {
        if (r.kind === "removed") {
          return `<div class="ln ln-del" title="Only in the pre-check">${esc(lineText(r.pre))}</div>`;
        }
        // A whole new line is already coloured; marking its text too would double up.
        if (r.kind === "added") return `<div class="ln ln-add" title="New in the post-check">${esc(lineText(r.post))}</div>`;
        return `<div class="ln${r.kind === "changed" ? " ln-chg" : ""}">${segHtml(r.post, "hot") || " "}</div>`;
      }).join("")}</div></div>`;
    }

    function sideBySide(rows) {
      const cell = (segs, kind, side) => {
        if (!segs) return '<td class="ln ln-gap"></td>';
        const cls = kind === "same" ? "" : side === "pre" ? (kind === "removed" ? " ln-del" : " ln-chg") : (kind === "added" ? " ln-add" : " ln-chg");
        const body = kind === "added" || kind === "removed" ? esc(lineText(segs))
          : segHtml(segs, side === "pre" ? "del" : "hot");
        return `<td class="ln${cls}">${body || " "}</td>`;
      };
      return `<div class="term"><table class="term-sbs">
        <thead><tr><th>Pre-check</th><th>Post-check</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>${cell(r.pre, r.kind, "pre")}${cell(r.post, r.kind, "post")}</tr>`).join("")}</tbody>
      </table></div>`;
    }

    function plainView(text) {
      return `<div class="term"><div class="term-in">${(text || "(no output)").split("\n")
        .map((l) => `<div class="ln">${esc(l) || " "}</div>`).join("")}</div></div>`;
    }

    function renderOutput() {
      const card = $$("ssrOutCard");
      const source = state.post?.data || state.pre?.data;
      if (!source) { card.classList.add("hidden"); return; }
      card.classList.remove("hidden");

      const routers = [...new Set([...Object.keys(state.pre?.data || {}), ...Object.keys(state.post?.data || {})])].sort();
      const sel = $$("ssrOutRouter");
      const keep = sel.value;
      sel.innerHTML = routers.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join("");
      sel.value = routers.includes(keep) ? keep : routers[0] || "";
      const router = sel.value;

      const hasPost = !!state.post;
      $$("ssrOutMode").disabled = !hasPost;
      $$("ssrOutChanged").disabled = !hasPost;
      $$("ssrOutTitle").textContent = hasPost ? "Output — post-check vs pre-check" : "Output — pre-check";
      $$("ssrOutLegend").innerHTML = hasPost
        ? `<span><mark class="hot">field</mark> changed</span><span><span class="swatch ln-add"></span>new line</span>
           <span><span class="swatch ln-del"></span>line gone since the pre-check</span>`
        : "Run the post-check to see what changed.";

      const mode = $$("ssrOutMode").value;
      const changedOnly = hasPost && $$("ssrOutChanged").checked;
      const blocks = [];
      for (const [key, [label, etype]] of Object.entries(CHECKS)) {
        const pre = state.pre?.data?.[router]?.[key];
        const post = state.post?.data?.[router]?.[key];
        if (pre === undefined && post === undefined) continue;
        const perNode = etype === "node_get";
        const preText = pre === undefined ? null : toCliText(pre, { perNode });
        if (!hasPost) {
          blocks.push(`<details class="term-block" open><summary>${esc(label)}</summary>${plainView(preText)}</details>`);
          continue;
        }
        const postText = post === undefined ? null : toCliText(post, { perNode });
        if (postText === null) {
          blocks.push(`<details class="term-block"><summary>${esc(label)} <span class="pill crit">not collected in the post-check</span></summary>${plainView(preText)}</details>`);
          continue;
        }
        const rows = diffText(preText || "", postText);
        const n = preText === null ? 0 : changedLines(rows);
        if (changedOnly && !n && preText !== null) continue;
        const badge = preText === null ? '<span class="pill">not in the pre-check</span>'
          : n ? `<span class="pill warn">${n} line(s) changed</span>` : '<span class="pill good">no change</span>';
        const body = preText === null ? plainView(postText) : mode === "side" ? sideBySide(rows) : postView(rows);
        blocks.push(`<details class="term-block"${n ? " open" : ""}><summary>${esc(label)} ${badge}</summary>${body}</details>`);
      }
      $$("ssrOutBody").innerHTML = blocks.join("")
        || '<p class="good" style="margin:0">No check on this router changed.</p>';
    }

    $$("ssrOutRouter").onchange = renderOutput;
    $$("ssrOutMode").onchange = renderOutput;
    $$("ssrOutChanged").onchange = renderOutput;

    $$("ssrFilter").oninput = () => { if (state.diff) renderDiff(); };
    $$("ssrCsv").onclick = () => {
      const rows = diffRows().map((r) => [r.router, r.check, r.path, r.pre, r.post, r.change]);
      const csv = ctx.toCsv(["Router", "Check", "Path", "Pre Value", "Post Value", "Change"], rows);
      const name = ctx.stampedName("ssr_prepost_diff",
        state.baseUrl ? new URL(state.baseUrl).hostname : "conductor", "csv");
      ctx.download(new Blob([csv], { type: "text/csv" }), name);
      log(`Saved ${name} to your downloads.`, "ok");
    };

    setPreState();
    updateScopeSub();
  },

  // mount() owns the view; run() keeps the tool shape uniform.
  async run() {
    return { rendered: true };
  },
};
