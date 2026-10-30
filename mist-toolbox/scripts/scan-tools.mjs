#!/usr/bin/env node
// Regenerates tools/tools.json from whatever .js files are sitting in tools/.
//
// This is the "drop a file in and it shows up" path: copy a tool into tools/,
// run `npm run scan`, reload the extension. Editing tools.json by hand works
// just as well — this only saves the keystrokes.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateTool } from "../tools/registry.js";

const toolsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "tools");
const SKIP = new Set(["registry.js"]);

const files = (await readdir(toolsDir))
  .filter((f) => f.endsWith(".js") && !SKIP.has(f))
  .sort();

const kept = [];
for (const file of files) {
  try {
    const mod = await import(pathToFileURL(join(toolsDir, file)).href);
    const tool = validateTool(mod.default, file);
    kept.push(file);
    process.stdout.write(`  ok    ${file.padEnd(28)} ${tool.name}\n`);
  } catch (e) {
    process.stdout.write(`  SKIP  ${file.padEnd(28)} ${e.message}\n`);
  }
}

const target = join(toolsDir, "tools.json");
const next = `${JSON.stringify(kept, null, 2)}\n`;
const prev = await readFile(target, "utf8").catch(() => "");
if (prev === next) {
  process.stdout.write(`\ntools.json already lists ${kept.length} tool(s).\n`);
} else {
  await writeFile(target, next);
  process.stdout.write(`\nWrote tools.json with ${kept.length} tool(s).\n`);
}
