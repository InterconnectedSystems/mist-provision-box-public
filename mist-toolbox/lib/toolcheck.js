// Static checks on a tool's source, run before it is installed.
//
// Two jobs. First, catch the common wrong file — a Node CLI script or a Python
// script — and say what it is, instead of letting the browser fail with
// "require is not defined". Second, hold uploaded tools to the same rules
// tests/policy.test.js holds shipped code to; the policy test imports the
// patterns below so the two can never drift apart. The one difference: an
// uploaded tool may make changes (POST/PUT/PATCH/DELETE). That is reported as a
// strong warning, not a problem, and the shell labels the tool; built-in tools
// stay read-only.
//
// This is a guard-rail against mistakes, not a security boundary. The page's
// CSP is what keeps the token on Mist; a tool runs with the same access as
// every other tool, and the install panel says so.

/** The shipped-code policy, shared with tests/policy.test.js. */
export const POLICY = {
  storage: /chrome\.storage\.(local|sync|session)|localStorage|sessionStorage|indexedDB|document\.cookie|chrome\.cookies/,
  serviceWorker: /chrome\.runtime\.(sendMessage|connect)\b/,
  console: /\bconsole\.(log|debug|info|warn|error|trace|dir|table)\s*\(/,
  post: /method:\s*["'`]POST["'`]/i,
};

/**
 * A tool that makes changes: it calls ctx.mistWrite, or names a write method.
 * Such tools are allowed. The installer warns about them and the shell labels
 * them "Makes changes", whether or not they declare `writes: true`.
 */
export const WRITES = /\bmistWrite\s*\(|method:\s*["'`](POST|PUT|PATCH|DELETE)["'`]/i;

/** True when the source can change Mist configuration. */
export function detectWrites(src) {
  return WRITES.test(String(src || ""));
}

const NODE = [
  [/\brequire\s*\(/, "require()"],
  [/\bmodule\.exports\b/, "module.exports"],
  [/\bprocess\.(env|argv|exit|stdout|stdin|stderr|cwd)\b/, "process"],
  [/\b__dirname\b|\b__filename\b/, "__dirname"],
  [/^#!.*\bnode\b/, "a #!node line"],
];

const PYTHON = /^\s*(def \w+\(.*\)\s*:|import \w+(\.\w+)*\s*$|from [\w.]+ import \w+)/m;

const RULES = [
  [POLICY.storage, "uses browser storage — tools must not persist anything (credentials could leak into it)"],
  [POLICY.serviceWorker, "messages the background service worker — the token must stay in the page"],
  [POLICY.console, "writes to console.* — report progress with ctx.log() instead"],
  [/\bfetch\s*\(/, "calls fetch() directly — use ctx.getAll / ctx.mistGet, which enforce the Mist host allowlist"],
  [/\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|navigator\.sendBeacon/, "opens its own network connection — use ctx.getAll / ctx.mistGet"],
  [/\beval\s*\(|\bnew Function\s*\(/, "uses eval / new Function, which the extension's security policy blocks"],
  [/\bimport\s*\(/, "uses dynamic import() — use a static import from ../lib/ instead"],
];

const ALLOWED_IMPORT = /^\.\.\/(lib\/[\w.-]+\.js|mist\.js|engine\/[\w.-]+\.js)$/;

export const MAX_TOOL_BYTES = 1024 * 1024;

export const WRITE_WARNING = "This tool can CHANGE your Mist configuration (POST, PUT, PATCH or DELETE). "
  + "Read it before installing, and run it only with a token that should be allowed to make these changes. "
  + "Read-only tools are best practice.";
export const UNDECLARED_WRITE_WARNING = "It does not declare `writes: true`. It will be labelled "
  + "\"Makes changes\" anyway; add the declaration so readers of the file can see it too.";

/**
 * @param {string} text  the uploaded file's contents
 * @param {string} [filename]
 * @returns {{problems: string[], warnings: string[], writeWarnings: string[], writes: boolean,
 *   id: string, name: string}}
 */
export function checkToolSource(text, filename = "") {
  const problems = [];
  const warnings = [];
  const writeWarnings = [];
  const src = String(text || "");

  if (/\.py$/i.test(filename) || (PYTHON.test(src) && !/\bexport\s+default\b/.test(src))) {
    problems.push("This is a Python script. Tools are JavaScript modules that run in the browser — "
      + "convert it with the AI prompt (Copy AI prompt, above).");
    return { problems, warnings, writeWarnings, writes: false, id: "", name: "" };
  }
  if (!src.trim()) problems.push("The file is empty.");
  if (src.length > MAX_TOOL_BYTES) problems.push("The file is over 1 MB — that is not a single tool.");

  const node = NODE.filter(([re]) => re.test(src)).map(([, what]) => what);
  if (node.length) {
    problems.push(`This is a Node.js script (uses ${node.join(", ")}). Tools run in the browser, `
      + "not in Node — convert it with the AI prompt (Copy AI prompt, above).");
  }

  if (!/\bexport\s+default\b/.test(src)) {
    problems.push("No `export default { … }` — a tool must default-export its tool object.");
  }

  for (const [re, why] of RULES) if (re.test(src)) problems.push(`It ${why}.`);

  for (const m of src.matchAll(/\bimport\s+(?:[\w*{}\s,]+\s+from\s+)?["']([^"']+)["']/g)) {
    if (!ALLOWED_IMPORT.test(m[1])) {
      problems.push(`It imports "${m[1]}" — only the toolbox's own ../lib/*.js, ../engine/*.js `
        + "and ../mist.js can be imported (there is no npm in the browser).");
    }
  }

  const id = (src.match(/\bid:\s*["'`]([^"'`]+)["'`]/) || [])[1] || "";
  const name = (src.match(/\bname:\s*["'`]([^"'`]+)["'`]/) || [])[1] || "";
  if (id && !/^[a-z0-9-]+$/.test(id)) problems.push(`The id "${id}" must be lowercase letters, digits and dashes.`);
  if (!/\bdescription\s*:/.test(src)) warnings.push("No description found — the menu card will be rejected without one.");
  if (/\bctx\.token\b/.test(src)) {
    warnings.push("It reads ctx.token, which tools are not given. Use the ctx helpers, which add the token for you.");
  }

  const writes = detectWrites(src);
  if (writes) {
    writeWarnings.push(WRITE_WARNING);
    if (!/\bwrites\s*:\s*true\b/.test(src)) writeWarnings.push(UNDECLARED_WRITE_WARNING);
  }

  return { problems, warnings, writeWarnings, writes, id, name };
}

/** "Mist Switch Report.JS" -> "mist-switch-report.js" */
export function toolFilename(name) {
  const base = String(name || "").replace(/\.js$/i, "").toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return base ? `${base}.js` : "";
}
