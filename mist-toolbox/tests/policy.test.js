// The security posture, enforced mechanically.
//
// Rewritten from the disconnect console's tests/token-hygiene.test.js. Three
// rules changed deliberately when the console became a toolbox, and the reasons
// are recorded here so a future reader does not "fix" them back:
//
//   * host_permissions grew from 9 to 13 Mist regions, because the Python
//     scripts between them knew regions the console did not.
//   * optional_host_permissions is now declared, for the SSR Conductor, whose
//     host only the user knows. Nothing is granted until they connect.
//   * GET-only is now scoped rather than global: the Mist tools stay GET-only,
//     and POST is confined to the SSR tool, which needs it for /login and for
//     the one session-count endpoint the Conductor only answers to POST.
//   * toolbox.html may also open WebSockets, to exactly the 13 Mist "api-ws."
//     hosts, for read-only switch CLI sessions (ctx.junosShow). Browsers cannot
//     put the token on a WebSocket; Mist hands back a wss:// URL with its own
//     short-lived JWT, and mist.js is still the only file that connects.
//
// Everything that protects the credential is unchanged, including the absolute
// ban on persisting anything.

import { strict as assert } from "node:assert";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { MIST_HOSTS, MIST_WS_HOSTS } from "../engine/util.js";
import { POLICY, detectWrites } from "../lib/toolcheck.js";
import { BUILTIN_TOOLS } from "../tools/registry.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Everything that actually ships inside the extension package. */
const SKIP_DIRS = new Set(["tests", "scripts", "node_modules", ".git"]);
const SKIP_FILES = new Set(["package.json", "package-lock.json", "README.md"]);

async function shipped(ext) {
  const out = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(join(dir, e.name));
      } else if (!SKIP_FILES.has(e.name) && (!ext || ext.some((x) => e.name.endsWith(x)))) {
        out.push(join(dir, e.name));
      }
    }
  }
  await walk(root);
  return out;
}

const read = async (f) => ({ path: relative(root, f), text: await readFile(f, "utf8") });

test("nothing persists: no storage API anywhere in shipped code", async () => {
  // lib/toolcheck.js holds these patterns to check uploaded tools, so it
  // necessarily contains the words as text; it is the one file excused.
  for (const f of await shipped([".js", ".html", ".json", ".css"])) {
    const { path, text } = await read(f);
    if (path === "lib/toolcheck.js") continue;
    const banned = POLICY.storage;
    assert.ok(!banned.test(text), `${path} uses a storage API — credentials must never be persisted`);
  }
});

test("no credential can cross to the service worker", async () => {
  const banned = POLICY.serviceWorker;
  for (const f of await shipped([".js", ".html"])) {
    const { path, text } = await read(f);
    assert.ok(!banned.test(text), `${path} messages the service worker; the token must stay in the page`);
  }
});

test("no console.* in shipped code", async () => {
  // Kept absolute by writing the xlsx layer rather than vendoring a bundle.
  const banned = POLICY.console;
  for (const f of await shipped([".js"])) {
    const { path, text } = await read(f);
    assert.ok(!banned.test(text), `${path} logs to the console`);
  }
});

// ---- The token can only reach the Mist regions ---------------------------------

const metaCsp = (html) => {
  const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
  if (!m) return null;
  return Object.fromEntries(m[1].split(";").map((d) => d.trim()).filter(Boolean)
    .map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v.join(" ")]; }));
};
const TOKEN_PAGES = ["toolbox.html", "console.html", "docs/view.html"];

test("pages that hold the Mist token may only connect to the Mist regions", async () => {
  const https = ["'self'", ...MIST_HOSTS.map((h) => `https://${h}`)];
  for (const page of TOKEN_PAGES) {
    const csp = metaCsp(await readFile(join(root, page), "utf8"));
    assert.ok(csp, `${page} has no CSP <meta>`);
    // Only the toolbox runs tools, so only it may open the CLI WebSockets.
    const want = (page === "toolbox.html" ? [...https, ...MIST_WS_HOSTS.map((h) => `wss://${h}`)] : https).join(" ");
    assert.equal(csp["connect-src"], want,
      `${page}: connect-src must be exactly 'self' + MIST_HOSTS${page === "toolbox.html" ? " + MIST_WS_HOSTS (wss)" : ""}, in order`);
    // Not just fetch: images, frames, fonts and forms could carry the token out too.
    assert.equal(csp["default-src"], "'self'", page);
    assert.equal(csp["img-src"], "'self' data: blob:", page);
    assert.equal(csp["frame-src"], "'none'", page);
    assert.equal(csp["form-action"], "'none'", page);
    assert.equal(csp["base-uri"], "'none'", page);
  }
});

test("ssr.html is the only page that may reach any HTTPS host", async () => {
  const pages = (await shipped([".html"])).map((f) => relative(root, f)).sort();
  assert.deepEqual(pages, [...TOKEN_PAGES, "ssr.html"].sort(), "a new page needs a CSP decision");
  const csp = metaCsp(await readFile(join(root, "ssr.html"), "utf8"));
  assert.equal(csp["connect-src"], "'self' https:");
  assert.equal(csp["default-src"], "'self'");
  assert.ok(!(await readFile(join(root, "ssr.js"), "utf8")).includes("mistGet"), "ssr.js never touches Mist");
});

test("tools are never handed the token", async () => {
  const shell = await readFile(join(root, "toolbox.js"), "utf8");
  const body = shell.slice(shell.indexOf("function buildCtx"), shell.indexOf("async function run()"));
  const ret = body.slice(body.indexOf("return {"));
  assert.ok(!/^\s*token\s*[:,]/m.test(ret), "buildCtx must not put token on ctx");
});

// Built-in tools are read-only unless they are labelled as making changes,
// and only the tools named here may be. Adding one is a deliberate decision.
const WRITE_BUILTINS = new Set(["ap-site-upgrade.js", "ssid-client-lists.js", "switch-site-upgrade.js"]);

test("a built-in tool that makes changes says so, and is one we chose", async () => {
  for (const file of BUILTIN_TOOLS) {
    const text = await readFile(join(root, "tools", file), "utf8");
    const writes = detectWrites(text);
    const declared = /\bwrites\s*:\s*true\b/.test(text);
    assert.equal(declared, writes, `${file}: writes: true must be declared exactly when the tool makes changes`);
    assert.equal(writes, WRITE_BUILTINS.has(file),
      writes ? `${file} makes changes but is not in WRITE_BUILTINS` : `${file} is in WRITE_BUILTINS but only reads`);
  }
});

test("POST is confined to the SSR tool", async () => {
  const ALLOWED = new Set(["ssr/ssr-pre-post.js"]);
  const post = POLICY.post;
  for (const f of await shipped([".js"])) {
    const { path, text } = await read(f);
    if (ALLOWED.has(path)) continue;
    assert.ok(!post.test(text), `${path} issues a POST; built-in tools are read-only (mist.js sends writes for labelled tools only)`);
  }
});

test("mist.js keeps one fetch, with the allowlist and HTTPS checks on it", async () => {
  const text = await readFile(join(root, "mist.js"), "utf8");
  assert.equal((text.match(/await fetch\(/g) || []).length, 1,
    "one fetch only — it is the enforcement point for the host allowlist");
  assert.ok(text.includes("MIST_HOSTS.includes(host)"), "host allowlist check missing");
  assert.ok(text.includes('url.protocol !== "https:"'), "HTTPS check missing");
  assert.ok(text.includes('credentials: "omit"'), "cookies must never ride along");
});

test("MIST_WS_HOSTS is MIST_HOSTS with api. replaced by api-ws., in order", () => {
  assert.equal(MIST_WS_HOSTS.length, MIST_HOSTS.length);
  MIST_HOSTS.forEach((h, i) => assert.equal(MIST_WS_HOSTS[i], h.replace(/^api\./, "api-ws.")));
});

test("mist.js is the only code that opens a WebSocket, and checks where it connects", async () => {
  for (const f of await shipped([".js"])) {
    const { path, text } = await read(f);
    if (path === "mist.js" || path === "lib/toolcheck.js") continue;
    assert.ok(!/\bnew WebSocket\s*\(/.test(text), `${path} opens a WebSocket; only mist.js may`);
  }
  const text = await readFile(join(root, "mist.js"), "utf8");
  assert.equal((text.match(/new WebSocket\(/g) || []).length, 1, "one WebSocket only, in openDeviceShell");
  const fn = text.slice(text.indexOf("export async function openDeviceShell"), text.indexOf("new WebSocket("));
  assert.ok(fn.includes("SHELL_PATH.test(path)"), "the shell POST must be held to the fixed path");
  assert.ok(fn.includes('url.protocol !== "wss:"'), "wss check missing");
  assert.ok(fn.includes("url.hostname !== wsHost"), "region WebSocket host check missing");
  assert.ok(fn.includes('url.pathname.startsWith("/ssh")'), "path check missing");
  assert.ok(!/log\(|message.*url\.href|\$\{url/.test(fn), "the session URL carries a JWT; never log it or put it in an error");
});

test("manifest declares no permissions and the exact CSP", async () => {
  const m = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  assert.equal(m.permissions, undefined, "no permissions array: downloads use a Blob anchor");
  assert.equal(m.content_scripts, undefined, "no content scripts");
  assert.equal(m.web_accessible_resources, undefined, "nothing exposed to web pages");
  // The outer limit: HTTPS, plus WebSockets to the Mist regions' api-ws hosts
  // only. Chrome does not let "https:" cover wss:, so the CLI sockets need the
  // hosts named here as well as in toolbox.html. The pages narrow this further
  // with their own <meta> CSP (tested above); ssr.html, which must reach a
  // Conductor only the user knows, keeps https: and no sockets.
  assert.equal(m.content_security_policy.extension_pages,
    `script-src 'self'; object-src 'self'; connect-src 'self' https: ${MIST_WS_HOSTS.map((h) => `wss://${h}`).join(" ")}`);
  assert.equal(m.action.default_popup, undefined, "the action opens a tab, not a popup");
  assert.deepEqual(m.optional_host_permissions, ["https://*/*"],
    "the SSR Conductor host is requested at runtime, not granted up front");
});

test("host_permissions matches MIST_HOSTS exactly, in order", async () => {
  const m = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  assert.deepEqual(m.host_permissions, MIST_HOSTS.map((h) => `https://${h}/*`));
  assert.equal(MIST_HOSTS.length, 13);
  assert.ok(MIST_HOSTS.includes("api.us.mist-federal.com"), "the US Gov region came from mist_ip_blocks.py");
});

test("the credential bar is not a form, so no password manager offers to save the token", async () => {
  const html = await readFile(join(root, "toolbox.html"), "utf8");
  const bar = html.slice(html.indexOf('id="formSession"'), html.indexOf("</section>"));
  assert.ok(!/<form/i.test(bar), "the credential bar must not be a <form>");
  assert.ok(/id="btnConnect"[^>]*type="button"/.test(html), "btnConnect must be type=button");
  assert.ok(/id="token"[^>]*type="password"/.test(html), "the token field must be type=password");
  assert.ok(/id="token"[^>]*autocomplete="new-password"/.test(html));
});

test("every shipped page loads only local scripts", async () => {
  for (const f of await shipped([".html"])) {
    const { path, text } = await read(f);
    for (const m of text.matchAll(/<(?:script|link)[^>]*(?:src|href)="([^"]+)"/g)) {
      assert.ok(!/^(https?:)?\/\//.test(m[1]), `${path} loads ${m[1]} off-origin`);
    }
  }
});
