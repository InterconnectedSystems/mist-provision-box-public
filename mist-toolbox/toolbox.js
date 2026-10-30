// Toolbox shell: credentials, the tool menu, the generated parameter form, and
// the run lifecycle. Tools themselves know nothing about the DOM unless they opt
// into rendering their own view.
//
// state.token is the token's entire lifetime, exactly as in the disconnect
// console it grew out of: set from the input, used by the ctx helpers, never
// handed to a tool, never stored, never messaged to the service worker, never
// logged. The page's CSP (toolbox.html) only lets it reach the Mist regions.

import { DEFAULT_MIST_HOST, MIST_REGIONS } from "./engine/util.js";
import { download, safeName, stampedName, toCsv } from "./lib/download.js";
import {
  $, epochToUtc, esc, fmtBytes, fmtMac, fmtTime, previewTable,
} from "./lib/dom.js";
import { getAll, searchAll } from "./lib/paginate.js";
import { STYLE, colLetter, sheet, workbook } from "./lib/xlsx.js";
import { POOL_LIMIT, listSites, mistConnect, mistGet, mistGetFull, mistWrite, pool } from "./mist.js";
import { tokenAccess } from "./lib/access.js";
import { effectiveParams, resolveSites, scopeChip } from "./lib/scope.js";
import { checkToolSource, toolFilename } from "./lib/toolcheck.js";
import {
  installTool, removeTool, toolExists, verifyExtensionDir,
} from "./lib/installer.js";
import { BUILTIN_TOOLS, loadOne, loadTools } from "./tools/registry.js";

/** Wipe credentials after this long without interaction, as the console did. */
const IDLE_WIPE_MS = 30 * 60 * 1000;

const state = {
  token: "", host: DEFAULT_MIST_HOST, email: "",
  orgs: [], orgId: "", connected: false,
  // What the token may do in the selected org (lib/access.js), from GET /self.
  privileges: [], access: null,
  tools: [], errors: [], tool: null,
  running: false, ctl: null, sites: null,
  // Add-tool panel. extDir is a folder handle, held in memory for this tab only.
  extDir: null, pending: null,
};

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

const hostSel = $("host");
MIST_REGIONS.forEach((r) => {
  const o = document.createElement("option");
  o.value = r.host;
  o.textContent = `${r.label} — ${r.portal}${r.host === DEFAULT_MIST_HOST ? " (default)" : ""}`;
  hostSel.appendChild(o);
});
hostSel.value = DEFAULT_MIST_HOST;

function show(view) {
  $("viewHome").classList.toggle("hidden", view !== "home");
  $("viewTool").classList.toggle("hidden", view !== "tool");
  $("btnHome").classList.toggle("hidden", view === "home");
  // The Mist credential bar is noise on a tool that collects its own.
  const needsMist = view !== "tool" || state.tool?.needs?.mistToken !== false;
  $("sessionCard").classList.toggle("hidden", !needsMist);
}
function setErr(msg) {
  const e = $("err");
  e.textContent = msg || "";
  e.classList.toggle("hidden", !msg);
  if (msg) e.scrollIntoView({ block: "nearest" });
}
function setSub() {
  const bits = [state.host];
  if (state.email) bits.push(state.email);
  if (state.access) bits.push(state.access.label);
  $("sub").textContent = state.connected ? bits.join(" · ") : "not connected";
}

/** Recompute what the token may do in the selected org, and show it. */
function updateAccess() {
  state.access = state.connected ? tokenAccess(state.privileges, state.orgId) : null;
  const badge = $("accessBadge");
  const hint = $("accessHint");
  if (!state.access) {
    badge.classList.add("hidden");
    hint.textContent = "";
  } else {
    badge.className = `access-badge access-${state.access.level}`;
    badge.textContent = state.access.label;
    badge.title = state.access.detail || state.access.label;
    hint.textContent = state.access.canWrite
      ? "Best practice: use a read-only (Observer) token unless you are running a tool that makes changes."
      : "";
  }
  setSub();
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

async function connect() {
  setErr("");
  $("btnConnect").disabled = true;
  try {
    const typed = $("token").value.trim();
    if (typed.length < 8) throw new Error("Paste a Mist API token (a read-only Observer token is recommended).");
    state.token = typed;
    state.host = hostSel.value;
    const res = await mistConnect(state.token, state.host);
    state.email = res.email;
    state.orgs = res.orgs || [];
    state.privileges = res.privileges || [];
    state.orgId = state.orgs[0]?.id || "";
    state.connected = true;
    state.sites = null;
    // Clear the field once the token is in memory — nothing else should hold it.
    $("token").value = "";
    fillSelect($("org"), state.orgs);
    $("orgRow").classList.toggle("hidden", !state.orgs.length);
    $("orgHint").textContent = state.orgs.length > 1
      ? `${state.orgs.length} organizations available to this token.`
      : "";
    updateAccess();
    renderGrid();
  } catch (err) {
    state.connected = false;
    setErr(err.message);
  } finally {
    $("btnConnect").disabled = false;
  }
}

function fillSelect(el, items) {
  el.innerHTML = "";
  items.forEach((it) => {
    const o = document.createElement("option");
    o.value = it.id;
    o.textContent = it.name || it.id;
    el.appendChild(o);
  });
  if (items[0]) el.value = items[0].id;
}

function wipe(message) {
  state.token = ""; state.email = ""; state.orgs = []; state.orgId = "";
  state.privileges = []; state.access = null;
  state.connected = false; state.sites = null; state.tool = null;
  state.ctl?.abort();
  state.running = false;
  $("token").value = "";
  $("orgRow").classList.add("hidden");
  updateAccess();
  renderGrid();
  show("home");
  setErr(message || "");
  $("btnWipe").classList.add("hidden");
  resetAdd();
}

$("btnConnect").onclick = connect;
$("token").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); connect(); }
});
$("org").onchange = () => { state.orgId = $("org").value; state.sites = null; updateAccess(); };
$("btnWipe").onclick = () => wipe("Session ended. The token has been wiped.");
$("btnHome").onclick = () => show("home");
$("crumbHome").onclick = () => show("home");

// ---------------------------------------------------------------------------
// Tool menu
// ---------------------------------------------------------------------------

function renderGrid() {
  const grid = $("toolGrid");
  // Tools added from the panel carry a Remove button under their card; the
  // built-ins never do.
  const removable = (file) => !BUILTIN_TOOLS.includes(file) && file !== "tools.json";
  const removeBtn = (file, label) => (removable(file)
    ? `<button class="btn btn-g card-remove" type="button" data-remove="${esc(file)}" data-label="${esc(label)}">Remove</button>`
    : "");
  const cards = state.tools.map((t) => {
    const needsToken = t.needs?.mistToken !== false;
    const locked = needsToken && !state.connected;
    const added = removable(t.__file);
    const tag = locked ? "validate a token to use" : (t.tag || (needsToken ? "Mist API" : "standalone"));
    const chip = scopeChip(t);
    const kind = t.__writes
      ? '<span class="kind-chip kind-writes" title="This tool can change your Mist configuration">Makes changes</span>'
      : '<span class="kind-chip kind-read">Read-only</span>';
    return `<div class="tool-slot">
      <button class="tool-card${t.__writes ? " writes" : ""}" data-tool="${esc(t.id)}" type="button"${locked ? ' disabled aria-disabled="true"' : ""}>
        <h2>${esc(t.name)}${chip ? ` <span class="scope-chip">${esc(chip)}</span>` : ""}</h2>
        <div class="kind">${kind}</div>
        <p>${esc(t.description)}</p>
        <span class="tag">${esc(tag)}${added ? " · added" : ""}</span>
      </button>${removeBtn(t.__file, t.name)}
    </div>`;
  });
  const broken = state.errors.map((e) => `<div class="tool-slot">
      <div class="tool-card broken">
        <h2 class="crit">${esc(e.file)}</h2>
        <p>This tool did not load: ${esc(e.message)}</p>
        <span class="tag">not available</span>
      </div>${removeBtn(e.file, e.file)}
    </div>`);
  grid.innerHTML = cards.concat(broken).join("")
    || '<p class="muted">No tools are registered. Check tools/tools.json.</p>';
  grid.querySelectorAll("[data-tool]").forEach((b) => {
    b.onclick = () => openTool(b.getAttribute("data-tool"));
  });
  grid.querySelectorAll("[data-remove]").forEach((b) => {
    b.onclick = () => uninstall(b.getAttribute("data-remove"), b.getAttribute("data-label"));
  });
  $("btnWipe").classList.toggle("hidden", !state.connected);
  $("regNote").textContent = `${state.tools.length} tool${state.tools.length === 1 ? "" : "s"} registered`
    + (state.errors.length ? ` · ${state.errors.length} failed to load` : "")
    + " · add or remove your own with Manage tools";
  renderInstalled();
}

// ---------------------------------------------------------------------------
// Add / remove tools
// ---------------------------------------------------------------------------
//
// The file is checked as text first (lib/toolcheck.js), so the common mistake —
// a Node or Python script — is explained before anything touches the disk.
// Installing writes into the unpacked extension folder (lib/installer.js),
// then re-imports the tool; if that import fails, both files are put back.

function addStatus(msg, kind = "") {
  const el = $("addStatus");
  el.textContent = msg || "";
  el.className = kind || "muted";
}

function resetAdd() {
  state.pending = null;
  $("toolFile").value = "";
  $("dropLabel").textContent = "Drop a .js file here, or click to choose";
  $("checkOut").innerHTML = "";
  $("btnInstall").classList.add("hidden");
  addStatus("");
}

async function onToolFile(file) {
  resetAdd();
  if (!file) return;
  $("dropLabel").textContent = file.name;
  const text = await file.text();
  const filename = toolFilename(file.name);
  const { problems, warnings, writeWarnings, id, name } = checkToolSource(text, file.name);

  if (!filename) problems.push("The filename has no usable characters — rename it, e.g. my-report.js.");
  else if (filename === "registry.js" || BUILTIN_TOOLS.includes(filename)) {
    problems.push(`${filename} is the name of a built-in file. Rename yours.`);
  }
  const clash = id && state.tools.find((t) => t.id === id && t.__file !== filename);
  if (clash) problems.push(`The id "${id}" is already used by ${clash.name} (${clash.__file}). Give the tool its own id.`);

  if (problems.length) {
    $("checkOut").innerHTML = `<p class="crit" style="margin:0;font-size:13px"><strong>This file can't be installed:</strong></p>
      <ul class="checklist crit">${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`;
    return;
  }
  state.pending = { filename, text };
  $("checkOut").innerHTML = `<dl style="margin-top:0">
      <dt>Tool</dt><dd>${esc(name || "(name not detected)")}</dd>
      <dt>ID</dt><dd class="mono">${esc(id || "(not detected)")}</dd>
      <dt>Installs as</dt><dd class="mono">tools/${esc(filename)}</dd>
    </dl>
    ${writeWarnings.length ? `<div class="write-banner"><strong>Makes changes</strong>
      <ul class="checklist">${writeWarnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
    ${warnings.length ? `<ul class="checklist warn">${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
    <div class="trust" style="margin-top:.6rem">A tool runs with access to your Mist session, like every
      other tool here. The check above catches mistakes, not malice — only install tools from people you trust.</div>`;
  $("btnInstall").classList.remove("hidden");
}

/** The unpacked extension folder, asked for once per tab and kept in memory. */
async function extensionDir() {
  if (state.extDir) {
    const opts = { mode: "readwrite" };
    const { root } = state.extDir;
    if ((await root.queryPermission(opts)) === "granted"
      || (await root.requestPermission(opts)) === "granted") return state.extDir;
    state.extDir = null;
  }
  if (typeof window.showDirectoryPicker !== "function") {
    throw new Error("This browser can't write to folders. Install by hand: copy the file into tools/, "
      + "run `npm run scan` (or add its name to tools/tools.json), then reload the extension.");
  }
  addStatus("Pick the mist-toolbox folder — the one you chose with Load unpacked.");
  const root = await window.showDirectoryPicker({ id: "mist-toolbox", mode: "readwrite" });
  const tools = await verifyExtensionDir(root, chrome.runtime.getManifest());
  state.extDir = { root, tools };
  return state.extDir;
}

/** Re-import a just-written tool and make sure it fits alongside the others. */
async function verifyInstalled(file) {
  const url = chrome.runtime.getURL(`tools/${file}`);
  const served = await fetch(url, { cache: "no-store" }).then((r) => r.ok, () => false);
  if (!served) {
    // The file is on disk but this browser is not serving it live; the
    // registry will validate it after a reload instead.
    state.needsReload = true;
    return;
  }
  const tool = await loadOne(file, Date.now());
  const clash = state.tools.find((t) => t.id === tool.id && t.__file !== file);
  if (clash) throw new Error(`id "${tool.id}" is already used by ${clash.__file}`);
}

async function reloadTools() {
  const { tools, errors } = await loadTools({ bust: Date.now() });
  state.tools = tools;
  state.errors = errors;
  renderGrid();
}

function friendly(e) {
  if (e?.name === "AbortError") return "";
  if (e?.name === "SecurityError" || e?.name === "NotAllowedError") {
    return "The browser did not allow writing to that folder.";
  }
  return e?.message || String(e);
}

async function install() {
  const p = state.pending;
  if (!p) return;
  $("btnInstall").disabled = true;
  state.needsReload = false;
  try {
    const { tools } = await extensionDir();
    if (await toolExists(tools, p.filename)
      && !window.confirm(`tools/${p.filename} already exists. Replace it?`)) {
      addStatus("Not installed.");
      return;
    }
    addStatus("Installing…");
    await installTool(tools, p.filename, p.text, verifyInstalled);
    await reloadTools();
    resetAdd();
    addStatus(state.needsReload
      ? `Saved tools/${p.filename}. Reload the extension (chrome://extensions → reload) to see it.`
      : `Installed tools/${p.filename}.`, "good");
  } catch (e) {
    const msg = friendly(e);
    addStatus(msg ? `Not installed: ${msg}` : "Cancelled.", msg ? "crit" : "muted");
  } finally {
    $("btnInstall").disabled = false;
  }
}

async function uninstall(file, label = file) {
  if (!window.confirm(`Remove "${label}"?\n\ntools/${file} is deleted from the extension folder `
    + "and taken out of tools/tools.json. Built-in tools are not affected.")) return;
  setErr("");
  try {
    const { tools } = await extensionDir();
    await removeTool(tools, file);
    await reloadTools();
    addStatus(`Removed tools/${file}.`, "good");
  } catch (e) {
    const msg = friendly(e);
    // The card's Remove button can be pressed with the panel closed, so
    // failures go to the page-level alert as well.
    if (msg) setErr(`Could not remove ${label}: ${msg}`);
    addStatus(msg ? `Not removed: ${msg}` : "Cancelled.", msg ? "crit" : "muted");
  }
}

function renderInstalled() {
  const mine = state.tools.filter((t) => !BUILTIN_TOOLS.includes(t.__file))
    .map((t) => ({ file: t.__file, label: t.name }))
    .concat(state.errors.filter((e) => e.file !== "tools.json" && !BUILTIN_TOOLS.includes(e.file))
      .map((e) => ({ file: e.file, label: "did not load" })));
  const el = $("installedList");
  el.innerHTML = mine.length
    ? `<strong style="font-size:13px">Added tools</strong>
       <ul class="plain">${mine.map((m) => `<li class="row"><span><span class="mono">${esc(m.file)}</span>
         <span class="muted"> — ${esc(m.label)}</span></span>
         <button class="btn btn-g" type="button" data-remove="${esc(m.file)}" data-label="${esc(m.file)}">Remove</button></li>`).join("")}</ul>`
    : '<strong style="font-size:13px">Added tools</strong><p class="muted" style="font-size:13px;margin:.3rem 0 0">'
      + "None yet. Tools you add appear here and on the home screen with a Remove button. "
      + "Built-in tools can't be removed.</p>";
  el.querySelectorAll("[data-remove]").forEach((b) => {
    b.onclick = () => uninstall(b.getAttribute("data-remove"), b.getAttribute("data-label"));
  });
}

/** Save one of the shipped docs to the downloads folder. */
async function downloadDoc(name) {
  try {
    const res = await fetch(chrome.runtime.getURL(`docs/${name}`), { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    download(new Blob([await res.text()], { type: "text/markdown" }), name);
    addStatus(`Saved ${name} to your downloads.`, "good");
  } catch (e) {
    addStatus(`Could not download ${name}: ${e.message}`, "crit");
  }
}

async function copyPrompt() {
  try {
    const res = await fetch(chrome.runtime.getURL("docs/TOOL_PROMPT.md"), { cache: "no-store" });
    await navigator.clipboard.writeText(await res.text());
    addStatus("AI prompt copied. Paste it into an assistant, add your script at the end, and install the file it gives back.", "good");
  } catch (e) {
    addStatus(`Could not copy: ${e.message}. Open docs/TOOL_PROMPT.md from the extension folder instead.`, "crit");
  }
}

$("btnAddTool").onclick = () => {
  const panel = $("addPanel");
  panel.classList.toggle("hidden");
  if (!panel.classList.contains("hidden")) panel.scrollIntoView({ block: "nearest" });
};
$("btnCloseAdd").onclick = () => { $("addPanel").classList.add("hidden"); resetAdd(); };
$("btnCopyPrompt").onclick = copyPrompt;
$("btnDownloadGuide").onclick = () => downloadDoc("TOOL_GUIDE.md");
$("btnInstall").onclick = install;
$("toolFile").onchange = () => onToolFile($("toolFile").files[0]);
{
  const zone = $("dropZone");
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("over");
    onToolFile(e.dataTransfer?.files?.[0]);
  });
}

// ---------------------------------------------------------------------------
// Parameter form
// ---------------------------------------------------------------------------

function paramField(p) {
  const id = `p_${p.id}`;
  const cls = p.full ? "full" : "";
  const label = esc(p.label || p.id);
  const hint = p.hint ? `<span class="subtle" style="font-size:12px">${esc(p.hint)}</span>` : "";
  if (p.type === "checkbox") {
    return `<div class="${cls}"><div class="check">
      <input id="${id}" type="checkbox"${p.default ? " checked" : ""}/>
      <label for="${id}" style="margin:0">${label}</label>
    </div>${hint}</div>`;
  }
  if (p.type === "select") {
    const opts = (p.options || []).map((o) => {
      const v = typeof o === "string" ? o : o.value;
      const t = typeof o === "string" ? o : (o.label ?? o.value);
      return `<option value="${esc(v)}"${v === p.default ? " selected" : ""}>${esc(t)}</option>`;
    }).join("");
    return `<label class="${cls}"><span>${label}</span>
      <select id="${id}" data-from="${esc(p.optionsFrom || "")}">${opts}</select></label>${hint}`;
  }
  if (p.type === "textarea") {
    return `<label class="${cls}"><span>${label}</span>
      <textarea id="${id}" rows="6" style="width:100%;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--fg);padding:.6rem;font:inherit"
        placeholder="${esc(p.placeholder || "")}"></textarea></label>${hint}`;
  }
  const type = p.type === "password" ? "password" : p.type === "number" ? "number" : p.type === "file" ? "file" : "text";
  const extra = p.type === "password" ? ' autocomplete="new-password" spellcheck="false"' : "";
  const val = p.default !== undefined && p.type !== "file" ? ` value="${esc(p.default)}"` : "";
  return `<label class="${cls}"><span>${label}</span>
    <input id="${id}" type="${type}"${extra}${val} placeholder="${esc(p.placeholder || "")}"/></label>${hint}`;
}

async function populateDynamicSelects() {
  const dyn = $("toolParams").querySelectorAll("select[data-from]");
  for (const el of dyn) {
    const from = el.getAttribute("data-from");
    if (from === "sites") {
      if (!state.sites) {
        log("Loading sites…", "info");
        state.sites = await listSites(state.token, state.host, state.orgId);
      }
      fillSelect(el, state.sites);
    } else if (from === "orgs") {
      fillSelect(el, state.orgs);
    }
  }
}

/** "All sites in the org" disables the Site picker, for any tool with both. */
function wireScopeFields() {
  // Generated by paramField, so looked up inside the form rather than by $().
  const all = $("toolParams").querySelector("#p_allSites");
  const site = $("toolParams").querySelector("#p_siteId");
  if (!all || !site) return;
  const sync = () => { site.disabled = all.checked; };
  all.addEventListener("change", sync);
  sync();
}

function readParams(tool) {
  const out = {};
  for (const p of effectiveParams(tool)) {
    const el = $(`p_${p.id}`);
    if (!el) continue;
    if (p.type === "checkbox") out[p.id] = el.checked;
    else if (p.type === "number") out[p.id] = el.value === "" ? null : Number(el.value);
    else if (p.type === "file") out[p.id] = el.files?.[0] || null;
    else out[p.id] = el.value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

function log(msg, kind = "") {
  const el = $("log");
  const line = document.createElement("div");
  if (kind) line.className = kind;
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  $("logCard").classList.remove("hidden");
}
function progress(done, total, label) {
  $("progWrap").classList.remove("hidden");
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  $("prog").style.width = `${pct}%`;
  $("runStatus").textContent = label ? `${label} — ${done}/${total}` : `${done}/${total}`;
}
function status(text) { $("runStatus").textContent = text || ""; }

async function openTool(id) {
  const tool = state.tools.find((t) => t.id === id);
  if (!tool) return;
  state.tool = tool;
  setErr("");
  $("toolName").textContent = tool.name;
  const chip = scopeChip(tool);
  if (chip) $("toolName").insertAdjacentHTML("beforeend", ` <span class="scope-chip">${esc(chip)}</span>`);
  $("toolDesc").textContent = tool.description;
  $("toolCrumb").textContent = tool.name;
  $("toolNotice").innerHTML = writeBanner(tool) + (tool.notice
    ? `<div class="pii" style="margin-bottom:1rem">${esc(tool.notice)}</div>` : "");
  $("toolParams").innerHTML = effectiveParams(tool).map(paramField).join("");
  wireScopeFields();
  $("log").innerHTML = "";
  $("logCard").classList.add("hidden");
  $("resultCard").classList.add("hidden");
  $("resultBody").innerHTML = "";
  $("resultActions").innerHTML = "";
  $("toolHost").innerHTML = "";
  $("progWrap").classList.add("hidden");
  $("prog").style.width = "0";
  status("");
  show("tool");
  try {
    await populateDynamicSelects();
  } catch (e) {
    setErr(e.message);
  }
  // A tool may own its whole view instead of using the generated form.
  if (tool.mount) {
    $("btnRun").classList.add("hidden");
    try {
      await tool.mount(buildCtx(tool, {}));
    } catch (e) {
      setErr(e.message);
    }
  } else {
    $("btnRun").classList.remove("hidden");
  }
}

/** The warning a tool that makes changes carries, above its form. */
function writeBanner(tool) {
  if (!tool.__writes) return "";
  const readOnly = state.access?.level === "read";
  return `<div class="write-banner"><strong>This tool can change your Mist configuration.</strong>
    Best practice is read-only tools; run this one only if you mean to make its changes.${readOnly
    ? "<br>Your token is read-only for this org, so Mist will refuse its changes (403). Reads and dry runs still work."
    : ""}</div>`;
}

/** ctx.mistWrite: only for tools labelled "Makes changes", and every call is logged. */
function writeFor(tool, method, path, body, params) {
  if (!tool.__writes) throw new Error("This tool is not labelled as making changes. Add `writes: true` to it.");
  log(`${String(method).toUpperCase()} ${path}`, "info");
  return mistWrite(state.host, state.token, method, path, body, params);
}

function buildCtx(tool, params) {
  const ctl = new AbortController();
  state.ctl = ctl;
  const paged = { host: state.host, token: state.token, signal: ctl.signal };
  return {
    host: state.host,
    orgId: state.orgId,
    orgName: state.orgs.find((o) => o.id === state.orgId)?.name || state.orgId,
    orgs: state.orgs,
    params,
    signal: ctl.signal,
    mount: $("toolHost"),
    access: state.access,

    // Transport
    mistGet: (path, p, t) => mistGet(state.host, state.token, path, p, t),
    mistGetFull: (path, p, t) => mistGetFull(state.host, state.token, path, p, t),
    mistWrite: (method, path, body, p) => writeFor(tool, method, path, body, p),
    getAll: (path, p, onPage) => getAll({ ...paged, onPage }, path, p),
    searchAll: (path, p, onPage) => searchAll({ ...paged, onPage }, path, p),
    listSites: () => listSites(state.token, state.host, state.orgId),
    targetSites: () => resolveSites({
      getAll: (path, p) => getAll(paged, path, p),
      orgId: state.orgId,
      orgName: state.orgs.find((o) => o.id === state.orgId)?.name || state.orgId,
      params,
    }),
    pool, POOL_LIMIT,

    // Output
    xlsx: { workbook, sheet, STYLE, colLetter },
    download, stampedName, safeName, toCsv,

    // UI
    log, progress, status,
    esc, previewTable, fmtMac, fmtTime, epochToUtc, fmtBytes,
  };
}

async function run() {
  const tool = state.tool;
  if (!tool || state.running) return;
  const needsToken = tool.needs?.mistToken !== false;
  if (needsToken && !state.connected) { setErr("Validate a Mist token first."); return; }
  if (tool.needs?.org && !state.orgId) { setErr("This tool needs an organization."); return; }
  if (tool.__writes) {
    const org = state.orgs.find((o) => o.id === state.orgId)?.name || state.orgId || "your org";
    const can = state.access ? state.access.label : "permission unknown";
    if (!window.confirm(`${tool.name} can make changes to ${org}.\n\nYour token: ${can}.\n\nRun it?`)) return;
  }

  setErr("");
  state.running = true;
  $("btnRun").disabled = true;
  $("btnCancel").classList.remove("hidden");
  $("resultCard").classList.add("hidden");
  $("log").innerHTML = "";
  $("prog").style.width = "0";

  const ctx = buildCtx(tool, readParams(tool));
  const started = Date.now();
  try {
    const result = await tool.run(ctx);
    if (ctx.signal.aborted) { status("Cancelled."); log("Cancelled.", "info"); return; }
    await presentResult(tool, result, ctx);
    status(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (err) {
    if (ctx.signal.aborted) { status("Cancelled."); return; }
    setErr(err.message || String(err));
    log(err.message || String(err), "err");
    status("Failed.");
  } finally {
    state.running = false;
    $("btnRun").disabled = false;
    $("btnCancel").classList.add("hidden");
  }
}

async function presentResult(tool, result, ctx) {
  if (!result || result.rendered) return;
  const card = $("resultCard");
  const actions = $("resultActions");
  const body = $("resultBody");
  actions.innerHTML = "";
  body.innerHTML = "";

  if (result.summary) {
    body.innerHTML += `<p class="muted" style="margin:.4rem 0 1rem">${esc(result.summary)}</p>`;
  }
  $("resultTitle").textContent = result.title || `${tool.name} — result`;

  if (result.sheets?.length) {
    const name = result.filename || stampedName(tool.id.replace(/-/g, "_"), ctx.orgName, "xlsx");
    const blob = await workbook(result.sheets);
    const btn = document.createElement("button");
    btn.className = "btn btn-p";
    btn.type = "button";
    btn.textContent = `Download ${name}`;
    btn.onclick = () => download(blob, name);
    actions.appendChild(btn);
    // Hand it over without a second click; the button stays for repeat saves.
    download(blob, name);
    log(`Saved ${name} to your downloads.`, "ok");
  }

  for (const f of result.files || []) {
    const btn = document.createElement("button");
    btn.className = "btn btn-s";
    btn.type = "button";
    btn.textContent = `Download ${f.name}`;
    btn.onclick = () => download(f.blob, f.name);
    actions.appendChild(btn);
  }

  if (result.preview) {
    const p = result.preview;
    body.innerHTML += (p.title ? `<strong style="font-size:13px">${esc(p.title)}</strong>` : "")
      + previewTable(p.columns, p.rows, p.limit || 200);
  }
  card.classList.remove("hidden");
}

$("btnRun").onclick = run;
$("btnCancel").onclick = () => { state.ctl?.abort(); status("Cancelling…"); };

// ---------------------------------------------------------------------------
// Idle wipe
// ---------------------------------------------------------------------------

let idleTimer = null;
function resetIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (state.connected) wipe("Session wiped after 30 minutes idle. Paste the token again to continue.");
  }, IDLE_WIPE_MS);
}
["pointerdown", "keydown", "focusin"].forEach((ev) =>
  window.addEventListener(ev, resetIdle, { capture: true, passive: true }));
document.addEventListener("visibilitychange", resetIdle);
resetIdle();

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async () => {
  const { tools, errors } = await loadTools();
  state.tools = tools;
  state.errors = errors;
  renderGrid();
  show("home");
})();
