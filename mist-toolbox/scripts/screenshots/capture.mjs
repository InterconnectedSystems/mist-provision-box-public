#!/usr/bin/env node
// Regenerates docs/screenshots/*.png: loads the extension into headless
// Chromium, answers every Mist and Conductor request from fixtures.mjs (all
// synthetic — the repo is public), runs each tool, and captures the page.
//
//   node --experimental-websocket scripts/screenshots/capture.mjs [path-to-chromium]
//
// The extension is copied to a scratch folder first, with the demo Conductor
// added to host_permissions so the SSR tool does not stop at the browser's
// permission prompt (which a headless run cannot click). The shipped manifest
// is never touched.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { CONDUCTOR, ORG_ID, PHY_MAC, conductor, mist, setSelfRole } from "./fixtures.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = join(root, "docs", "screenshots");
const chromium = process.argv[2] || "/usr/bin/chromium";
const PORT = 9333;
const WIDTH = 1280;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Extension copy -----------------------------------------------------------

const work = await mkdtemp(join(tmpdir(), "mist-shots-"));
const extDir = join(work, "ext");
await cp(root, extDir, {
  recursive: true,
  filter: (src) => !/\/(node_modules|tests|\.git)(\/|$)/.test(src) && !src.includes("/docs/screenshots"),
});
const manifestPath = join(extDir, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.host_permissions.push(`${CONDUCTOR}/*`);
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

// Chrome's id for an unpacked extension: sha256 of its path, hex mapped to a-p.
const extId = [...createHash("sha256").update(extDir).digest("hex").slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
const extUrl = (p) => `chrome-extension://${extId}/${p}`;

// ---- Browser ----------------------------------------------------------------

const browser = spawn(chromium, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(work, "profile")}`,
  `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
  "--force-color-profile=srgb", `--window-size=${WIDTH},900`, "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

let wsUrl;
for (let i = 0; i < 50 && !wsUrl; i += 1) {
  await sleep(200);
  wsUrl = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).then((j) => j.webSocketDebuggerUrl, () => null);
}
if (!wsUrl) throw new Error("Chromium did not start");

const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const pending = new Map();
const listeners = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve: ok, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data || ""}`)); else ok(msg.result);
  } else if (msg.method) {
    for (const l of listeners) l(msg);
  }
};
const send = (method, params = {}, sessionId) => new Promise((ok, reject) => {
  const id = ++seq;
  pending.set(id, { resolve: ok, reject });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

// Give the service worker a moment to register the extension.
await sleep(1500);
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
const cmd = (method, params) => send(method, params, s);

await cmd("Page.enable");
await cmd("Runtime.enable");
await cmd("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: 900, deviceScaleFactor: 1, mobile: false });
await cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: join(work, "downloads") });

// ---- Fixture network ----------------------------------------------------------

let ssrPhase = "pre";
const served = [];
await cmd("Fetch.enable", { patterns: [{ urlPattern: "https://api.*" }, { urlPattern: `${CONDUCTOR}/*` }] });
listeners.push(async (msg) => {
  if (msg.method !== "Fetch.requestPaused" || msg.sessionId !== s) return;
  const { requestId, request } = msg.params;
  const u = new URL(request.url);
  let hit = null;
  if (u.origin === CONDUCTOR) hit = conductor(request.method, u.pathname, ssrPhase);
  else if (/(^|\.)mist(-federal)?\.com$/.test(u.hostname)) hit = mist(u.pathname.replace(/^\/api\/v1/, ""), u.searchParams, u.hostname);
  served.push(`${request.method} ${u.pathname}${hit ? "" : " (404)"}`);
  const body = hit ? JSON.stringify(hit.body) : "";
  const total = hit && Array.isArray(hit.body) ? String(hit.body.length) : null;
  await cmd("Fetch.fulfillRequest", {
    requestId,
    responseCode: hit ? 200 : 404,
    responseHeaders: [
      { name: "Content-Type", value: "application/json" },
      { name: "Access-Control-Allow-Origin", value: "*" },
      ...(total ? [{ name: "X-Page-Total", value: total }] : []),
    ],
    body: Buffer.from(body).toString("base64"),
  }).catch(() => {});
});

// ---- Stand-in folder picker -------------------------------------------------------
//
// showDirectoryPicker opens a native dialog a headless run cannot click. For
// the Manage tools screenshots the page gets a stand-in whose handle reads and
// writes the real files of the scratch extension copy through a CDP binding,
// so the install, the live re-import and the new card all genuinely happen.

const FS_SHIM = `(() => {
  if (window.__fsShim) return;
  window.__fsShim = true;
  let seq = 0;
  const waiting = {};
  window.__fsDone = (id, ok, value) => { const w = waiting[id]; delete waiting[id]; ok ? w.res(value) : w.rej(new DOMException(value, "NotFoundError")); };
  const call = (op, path, data) => new Promise((res, rej) => { const id = ++seq; waiting[id] = { res, rej }; window.__fsBridge(JSON.stringify({ id, op, path, data })); });
  const join = (a, b) => (a ? a + "/" + b : b);
  const dir = (rel) => ({
    kind: "directory", name: rel ? rel.split("/").pop() : "mist-toolbox",
    queryPermission: async () => "granted", requestPermission: async () => "granted",
    async getDirectoryHandle(n) { await call("isdir", join(rel, n)); return dir(join(rel, n)); },
    async getFileHandle(n, opts = {}) {
      const p = join(rel, n);
      if (!opts.create) await call("isfile", p);
      return {
        kind: "file", name: n,
        getFile: async () => { const t = await call("read", p); return { text: async () => t }; },
        createWritable: async () => { let buf = ""; return {
          write: async (t) => { buf = typeof t === "string" ? t : await new Blob([t]).text(); },
          close: async () => { await call("write", p, buf); } }; },
      };
    },
    async removeEntry(n) { await call("rm", join(rel, n)); },
  });
  window.showDirectoryPicker = async () => dir("");
})()`;

async function fsOp({ op, path, data }) {
  const full = resolve(extDir, path);
  if (full !== extDir && !full.startsWith(extDir + sep)) throw new Error("outside the extension");
  if (op === "isdir") { if (!(await stat(full)).isDirectory()) throw new Error("not a folder"); return true; }
  if (op === "isfile") { if (!(await stat(full)).isFile()) throw new Error("not a file"); return true; }
  if (op === "read") return readFile(full, "utf8");
  if (op === "write") { await writeFile(full, data); return true; }
  if (op === "rm") { await unlink(full); return true; }
  throw new Error(`unknown op ${op}`);
}

await cmd("Runtime.addBinding", { name: "__fsBridge" });
const fsWrites = [];
listeners.push(async (msg) => {
  if (msg.method !== "Runtime.bindingCalled" || msg.params.name !== "__fsBridge") return;
  const req = JSON.parse(msg.params.payload);
  let ok = true;
  let value;
  try { value = await fsOp(req); } catch (err) { ok = false; value = err.message; }
  if (req.op === "write" || req.op === "rm") fsWrites.push(`${req.op} ${relative(extDir, resolve(extDir, req.path))}`);
  await cmd("Runtime.evaluate", { expression: `window.__fsDone(${req.id}, ${ok}, ${JSON.stringify(value)})` });
});

// ---- Page helpers -------------------------------------------------------------

async function evaluate(expression) {
  const r = await cmd("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${expression.slice(0, 80)}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}

async function waitFor(expression, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await evaluate(`!!(${expression})`).catch(() => false)) return;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function go(url) {
  await cmd("Page.navigate", { url });
  await waitFor("document.readyState === 'complete'", `load ${url}`);
  await sleep(400);
}

const click = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
const setValue = (sel, v) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
  el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event("input", {bubbles:true})); el.dispatchEvent(new Event("change", {bubbles:true})); })()`);
const setChecked = (sel, v) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
  el.checked = ${v}; el.dispatchEvent(new Event("change", {bubbles:true})); })()`);

const shots = [];
/**
 * Capture the page from the top (so the sticky header stays where it
 * belongs), or just the region spanned by `only` selectors.
 */
async function shot(name, caption, only) {
  await evaluate("window.scrollTo(0, 0)");
  await sleep(300);
  let clip;
  if (only) {
    clip = await evaluate(`(() => {
      const rs = ${JSON.stringify(only)}.map((q) => document.querySelector(q))
        .filter((el) => el && el.offsetParent).map((el) => el.getBoundingClientRect());
      const top = Math.min(...rs.map((r) => r.top + scrollY)) - 16;
      const bottom = Math.max(...rs.map((r) => r.bottom + scrollY)) + 16;
      return { x: 0, y: Math.max(0, top), width: ${WIDTH}, height: Math.min(bottom - top, 4000), scale: 1 };
    })()`);
  } else {
    const { cssContentSize } = await cmd("Page.getLayoutMetrics");
    clip = { x: 0, y: 0, width: WIDTH, height: Math.min(Math.ceil(cssContentSize.height), 4000), scale: 1 };
  }
  const { data } = await cmd("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip });
  await writeFile(join(outDir, `${name}.png`), Buffer.from(data, "base64"));
  shots.push({ name, caption });
  process.stdout.write(`  ${name}.png  ${caption}\n`);
}

async function runTool(id, { params = {}, single } = {}) {
  await click("#btnHome").catch(() => {});
  await waitFor(`document.querySelector('[data-tool="${id}"]')`, `card ${id}`);
  await click(`[data-tool="${id}"]`);
  await waitFor("!document.getElementById('viewTool').classList.contains('hidden')", `${id} view`);
  if (single) {
    await waitFor(`document.querySelector('#p_siteId option[value="${single}"]')`, "site list");
    await setChecked("#p_allSites", false);
    await setValue("#p_siteId", single);
  }
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "boolean") await setChecked(`#p_${k}`, v); else await setValue(`#p_${k}`, v);
  }
  await click("#btnRun");
  await waitFor("!document.getElementById('resultCard').classList.contains('hidden') "
    + "&& !document.getElementById('btnRun').disabled", `${id} result`);
  await evaluate("window.scrollTo(0, 0)");
}

// ---- The tour -----------------------------------------------------------------

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

try {
  // chrome://extensions with Developer mode on and the toolbox loaded.
  await go("chrome://extensions");
  await evaluate(`(() => {
    const mgr = document.querySelector("extensions-manager");
    const bar = mgr.shadowRoot.querySelector("extensions-toolbar");
    const toggle = bar.shadowRoot.querySelector("#devMode");
    if (!toggle.checked) toggle.click();
  })()`);
  await sleep(800);
  await shot("00-chrome-extensions", "chrome://extensions — Developer mode on, Mist Toolbox loaded with Load unpacked");

  await go(extUrl("toolbox.html"));
  await shot("01-home-signed-out", "Tool menu before a token is validated");

  await setValue("#token", "demo-token-not-a-real-credential");
  await click("#btnConnect");
  await waitFor("!document.getElementById('orgRow').classList.contains('hidden')", "org list");
  await shot("02-home", "Tool menu with each tool's level (Site · Org, Site · Client, SSR Conductor)");

  await runTool("ssid-report");
  await shot("03-ssid-report", "SSID Report — every site in the org");

  await runTool("switch-report", { single: "site-hq" });
  await shot("04-switch-report-single-site", "Switch Software Report for one site (All sites unticked, Site picked)");

  await runTool("switch-configs");
  await shot("05-switch-config-export", "Switch Config Export — one .zip with a folder per site");

  await runTool("site-alarms", { params: { duration: "7d" } });
  await shot("06-site-alarms", "Site Alarms — past 7 days, all sites");

  await runTool("wifi-clients");
  await shot("07-wifi-clients", "Wi-Fi Clients Export");

  await runTool("client-wifi-phy", { params: { mac: PHY_MAC } });
  await shot("07b-client-wifi-phy", "Client Wi-Fi PHY Inspector — one client's radio link graded, site found automatically");

  await runTool("ip-blocks");
  await shot("08-ip-blocks", "IP Blocks / IRB Report — duplicate subnet flagged across sites");

  await runTool("port-inventory");
  await shot("09-port-inventory", "Switch Port Inventory");

  await runTool("switch-psu-status");
  await shot("09b-switch-psu-status", "Switch PSU Status — a failed supply and a switch without redundancy flagged");

  await runTool("switch-additional-cli");
  await shot("09c-switch-additional-cli", "Switch Additional CLI — template, rule, site and device commands side by side");

  // SSID Banned / Approved Clients draws its own screen, and only a token that can
  // make changes reaches Push, so sign in again with a write role for it.
  setSelfRole("write");
  await go(extUrl("toolbox.html"));
  await setValue("#token", "demo-token-not-a-real-credential");
  await click("#btnConnect");
  await waitFor("!document.getElementById('orgRow').classList.contains('hidden')", "org list");
  await click(`[data-tool="ssid-client-lists"]`);
  const bc = (id) => `[data-bc="${id}"]`;
  await waitFor(`document.querySelector('${bc("site")} option[value="site-hq"]')`, "SSID tool sites");
  await setValue(bc("site"), "site-hq");
  await setValue(bc("ssid"), "DemoCorp");
  await click(bc("getBtn"));
  await waitFor(`!document.querySelector('${bc("attrCard")}').classList.contains('bc-hidden') && !document.querySelector('${bc("getBtn")}').disabled`, "live clients");
  await click(`[data-attr="manufacture"][data-val="Apple"]`);
  await waitFor(`!document.querySelector('${bc("reviewCard")}').classList.contains('bc-hidden')`, "review");
  await shot("09d-ssid-clients-pick", "SSID Banned / Approved Clients — live clients on one SSID, picked by attribute and reviewed",
    [".bc .bc-card", bc("attrCard"), bc("reviewCard")]);
  await click(bc("planBtn"));
  await waitFor(`document.querySelector('${bc("pushBtn")}')`, "push preview");
  await shot("09e-ssid-clients-preview", "SSID Banned / Approved Clients — every request listed before anything is sent", [bc("pushCard")]);
  await click(bc("checkBtn"));
  await waitFor(`!document.querySelector('${bc("checkBtn")}').disabled && document.querySelector('${bc("current")}').innerText.trim()`, "current lists");
  await shot("09f-ssid-clients-current", "SSID Banned / Approved Clients — what is on the banned and approved lists now",
    [".bc > .bc-card:last-of-type"]);
  setSelfRole("read");
  await go(extUrl("toolbox.html"));
  await setValue("#token", "demo-token-not-a-real-credential");
  await click("#btnConnect");
  await waitFor("!document.getElementById('orgRow').classList.contains('hidden')", "org list");

  // SSR Pre/Post runs in its own tab (ssr.html): connect, pre-check, change, post-check.
  await go(extUrl("ssr.html"));
  await waitFor("document.querySelector('#ssrUrl')", "SSR form");
  await setValue("#ssrUrl", CONDUCTOR);
  await setValue("#ssrUser", "demo");
  await setValue("#ssrPass", "demo-password");
  await click("#ssrConnect");
  await waitFor("!document.getElementById('ssrScopeCard').classList.contains('hidden')", "SSR scope");
  ssrPhase = "pre";
  await click("#ssrPre");
  await waitFor("!document.getElementById('ssrPost').disabled", "pre-check");
  await shot("10-ssr-pre-check", "SSR Pre/Post Check — pre-check output, laid out like the CLI");
  ssrPhase = "post";
  await click("#ssrPost");
  await waitFor("!document.getElementById('ssrDiffCard').classList.contains('hidden') "
    + "&& !document.getElementById('ssrPre').disabled", "post-check");
  await shot("11-ssr-post-highlighted", "SSR post-check — changed fields highlighted in place", ["#ssrOutCard"]);
  await setValue("#ssrOutMode", "side");
  await shot("12-ssr-side-by-side", "SSR post-check — pre and post side by side", ["#ssrOutCard"]);
  await shot("12b-ssr-diff-table", "SSR post-check — every changed value, exportable to CSV", ["#ssrDiffCard"]);

  // Disconnect Console has its own sample mode.
  await go(extUrl("console.html#demo"));
  await waitFor("document.body.innerText.includes('sample')", "console demo", 20000);
  await shot("13-disconnect-console", "Disconnect Console — built-in sample investigation");

  // ---- Adding a tool with an AI assistant ----------------------------------------
  await go(extUrl("docs/view.html?doc=TOOL_PROMPT.md"));
  await waitFor("document.getElementById('doc').textContent.length > 1000", "prompt text");
  await shot("15-ai-prompt-top", "docs/TOOL_PROMPT.md in the docs viewer — Copy or Download it", ["main > .row", "#doc"]);
  const promptTail = await evaluate(`(() => { const r = document.getElementById("doc").getBoundingClientRect();
    return { top: r.bottom + scrollY - 520, height: 536 }; })()`);
  {
    const { data } = await cmd("Page.captureScreenshot", { format: "png", captureBeyondViewport: true,
      clip: { x: 0, y: promptTail.top, width: WIDTH, height: promptTail.height, scale: 1 } });
    await writeFile(join(outDir, "16-ai-prompt-paste-slot.png"), Buffer.from(data, "base64"));
    shots.push({ name: "16-ai-prompt-paste-slot", caption: "The end of the prompt — paste your script below the line" });
    process.stdout.write("  16-ai-prompt-paste-slot.png\n");
  }

  // Manage tools, signed in so the new tool can run afterwards.
  await go(extUrl("toolbox.html"));
  await setValue("#token", "demo-token-not-a-real-credential");
  await click("#btnConnect");
  await waitFor("!document.getElementById('orgRow').classList.contains('hidden')", "org list");
  await evaluate(FS_SHIM);
  await send("Browser.grantPermissions", { origin: `chrome-extension://${extId}`,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] }).catch(() => {});
  await cmd("Emulation.setFocusEmulationEnabled", { enabled: true });
  await click("#btnAddTool");
  await click("#btnCopyPrompt");
  await waitFor("/copied|Could not copy/.test(document.getElementById('addStatus').textContent)", "copy prompt");
  await shot("17-manage-copy-prompt", "Manage tools → Copy AI prompt", ["#addPanel"]);

  const pickFile = async (path) => {
    const { root: doc } = await cmd("DOM.getDocument", {});
    const { nodeId } = await cmd("DOM.querySelector", { nodeId: doc.nodeId, selector: "#toolFile" });
    await cmd("DOM.setFileInputFiles", { nodeId, files: [path] });
  };
  await pickFile(resolve(root, "..", "mist_switch_report.js"));
  await waitFor("document.getElementById('checkOut').innerText.includes('Node.js')", "upload check");
  await shot("14-manage-tools", "Manage tools — a Node script is explained, not installed", ["#addPanel"]);

  // The assistant's answer, saved as a .js — here, the shipped template.
  const answer = join(work, "device-count.js");
  await cp(join(root, "docs", "tool-template.js"), answer);
  await pickFile(answer);
  await waitFor("!document.getElementById('btnInstall').classList.contains('hidden')", "check passed");
  await shot("18-manage-check-passed", "The AI's .js passes the check — Install", ["#addPanel"]);

  await click("#btnInstall");
  await waitFor("/Installed|Saved|Not installed/.test(document.getElementById('addStatus').textContent)", "install");
  const status = await evaluate("document.getElementById('addStatus').textContent");
  if (!status.startsWith("Installed")) throw new Error(`install did not complete live: ${status}`);
  await shot("19-manage-installed", "Installed — written to tools/ and listed in tools/tools.json, no reload", ["#addPanel"]);
  await shot("20-home-added-tool", "The new tool's card, marked added, with a Remove button", ["#toolGrid"]);

  await runTool("device-count");
  await shot("21-added-tool-run", "The added tool running like any built-in one");
  process.stdout.write(`  (files written by Install: ${fsWrites.join(", ")})\n`);
} catch (e) {
  process.stderr.write(`\n${e.stack}\nRequests served:\n  ${served.slice(-25).join("\n  ")}\n`);
  process.exitCode = 1;
} finally {
  ws.close();
  // Wait for Chromium to let go of its profile before deleting it.
  const exited = new Promise((r) => browser.once("exit", r));
  browser.kill();
  await Promise.race([exited, sleep(5000)]);
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

if (!process.exitCode) {
  const md = shots.map((s) => `### ${s.caption}\n\n![${s.caption}](${s.name}.png)\n`).join("\n");
  await writeFile(join(outDir, "README.md"), `# Mist Toolbox screenshots\n\nGenerated by \`scripts/screenshots/capture.mjs\` against synthetic data (\`fixtures.mjs\`) — no real org.\n\n${md}`);
  process.stdout.write(`\n${shots.length} screenshots in docs/screenshots/ (org ${ORG_ID}, ${served.length} requests answered from fixtures)\n`);
}
