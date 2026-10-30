// toolbox.js, console.js and the tool views touch `document` and `chrome` at
// module scope, so Node cannot import them. A broken import there would
// otherwise only show up as a blank page in the browser, so the module graph is
// checked statically instead.

import { strict as assert } from "node:assert";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["tests", "scripts", "node_modules", ".git"]);

async function jsFiles() {
  const out = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(join(dir, e.name));
      } else if (e.name.endsWith(".js")) {
        out.push(join(dir, e.name));
      }
    }
  }
  await walk(root);
  return out;
}

/** Exported names of a module, by source inspection rather than import. */
function exportedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  // export { a, b as c }
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const bits = part.trim().split(/\s+as\s+/);
      const name = (bits[1] || bits[0] || "").trim();
      if (name) names.add(name);
    }
  }
  if (/^export\s+default\b/m.test(src)) names.add("default");
  return names;
}

test("every relative import resolves to a file that exists", async () => {
  const files = await jsFiles();
  const problems = [];
  for (const file of files) {
    const src = await readFile(file, "utf8");
    for (const m of src.matchAll(/^\s*(?:import|export)[^'"]*from\s+["'](\.[^"']+)["']/gm)) {
      const target = resolve(dirname(file), m[1]);
      try {
        await readFile(target, "utf8");
      } catch {
        problems.push(`${relative(root, file)} -> ${m[1]}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("every named import exists in the module it comes from", async () => {
  const files = await jsFiles();
  const cache = new Map();
  const problems = [];

  for (const file of files) {
    const src = await readFile(file, "utf8");
    // import { a, b } from "./x.js"  — the brace form only.
    for (const m of src.matchAll(/^\s*import\s*\{([^}]*)\}\s*from\s+["'](\.[^"']+)["']/gm)) {
      const target = resolve(dirname(file), m[2]);
      if (!cache.has(target)) {
        const text = await readFile(target, "utf8").catch(() => null);
        cache.set(target, text === null ? null : exportedNames(text));
      }
      const exported = cache.get(target);
      if (!exported) continue;   // the resolve test reports a missing file
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (!name) continue;
        if (!exported.has(name)) {
          problems.push(`${relative(root, file)} imports { ${name} } from ${m[2]}, which does not export it`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("the shell wires up every element id its markup declares", async () => {
  const html = await readFile(join(root, "toolbox.html"), "utf8");
  const js = await readFile(join(root, "toolbox.js"), "utf8");
  // Markup-only ids, each here for a stated reason rather than by oversight.
  const LANDMARKS = new Set([
    // tests/policy.test.js locates the credential bar by this id to assert it
    // is not a <form>.
    "formSession",
  ]);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 15, "sanity: the shell should declare plenty of ids");
  const missing = ids.filter((id) => !LANDMARKS.has(id)
    && !js.includes(`"${id}"`) && !js.includes(`'${id}'`));
  assert.deepEqual(missing, [], "ids in toolbox.html that toolbox.js never references");
});

test("every id toolbox.js looks up exists in the markup", async () => {
  const html = await readFile(join(root, "toolbox.html"), "utf8");
  const js = await readFile(join(root, "toolbox.js"), "utf8");
  const looked = [...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]);
  const absent = [...new Set(looked)].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(absent, [], "toolbox.js reads ids that toolbox.html does not define");
});
