// Installs a tool into the extension's own folder on disk.
//
// An extension cannot write into its package at runtime, but the toolbox is
// installed with "Load unpacked", so the package is an ordinary folder. The
// File System Access API lets the user hand this page write access to it (no
// manifest permission; Chrome asks the user itself), and unpacked extensions
// serve their files from disk live — so a tool written here can be imported
// straight away, without reloading the extension and losing the token.
//
// Everything here takes a FileSystemDirectoryHandle so it can be tested
// against an in-memory fake. Nothing is stored: the handle lives in page memory.

import { BUILTIN_TOOLS } from "../tools/registry.js";

const RESERVED = new Set(["registry.js", ...BUILTIN_TOOLS]);

async function readText(dir, name) {
  const fh = await dir.getFileHandle(name);
  return (await fh.getFile()).text();
}

async function writeText(dir, name, text) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

async function tryReadText(dir, name) {
  try { return await readText(dir, name); } catch { return null; }
}

/** Same format scripts/scan-tools.mjs writes, so the two never fight. */
export function formatToolsJson(list) {
  return `${JSON.stringify([...new Set(list)].sort(), null, 2)}\n`;
}

async function readList(tools) {
  const text = await tryReadText(tools, "tools.json");
  if (text === null) throw new Error("tools/tools.json is missing from that folder.");
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error("tools/tools.json is not a list.");
  return { text, list };
}

/**
 * Make sure the folder the user picked is this extension, not some other
 * folder. Returns the tools/ directory handle.
 */
export async function verifyExtensionDir(dir, running) {
  const raw = await tryReadText(dir, "manifest.json");
  if (raw === null) {
    throw new Error(`"${dir.name}" has no manifest.json. Pick the mist-toolbox folder — the one you `
      + "chose with Load unpacked.");
  }
  let m;
  try { m = JSON.parse(raw); } catch { throw new Error(`manifest.json in "${dir.name}" is not valid JSON.`); }
  if (m.name !== running.name) {
    throw new Error(`"${dir.name}" holds the extension "${m.name}", not "${running.name}".`);
  }
  if (m.version !== running.version) {
    throw new Error(`"${dir.name}" is version ${m.version}, but the loaded extension is ${running.version}. `
      + "Pick the folder this copy was loaded from.");
  }
  let tools;
  try { tools = await dir.getDirectoryHandle("tools"); } catch {
    throw new Error(`"${dir.name}" has no tools/ folder.`);
  }
  await readList(tools);
  return tools;
}

export function checkFilename(filename) {
  if (!/^[a-z0-9_.-]+\.js$/.test(filename)) {
    throw new Error(`"${filename}" is not a usable filename (lowercase letters, digits, - _ . and .js).`);
  }
  if (RESERVED.has(filename)) {
    throw new Error(`${filename} is a built-in file and cannot be replaced. Rename your tool.`);
  }
}

/** Is a file of that name already in tools/? */
export async function toolExists(tools, filename) {
  return (await tryReadText(tools, filename)) !== null;
}

/**
 * Write tools/<filename> and list it in tools.json, then run `verify`. If
 * anything fails, put both files back exactly as they were.
 */
export async function installTool(tools, filename, text, verify) {
  checkFilename(filename);
  const { text: oldJson, list } = await readList(tools);
  const oldFile = await tryReadText(tools, filename);
  try {
    await writeText(tools, filename, text);
    await writeText(tools, "tools.json", formatToolsJson([...list, filename]));
    if (verify) await verify(filename);
  } catch (e) {
    await writeText(tools, "tools.json", oldJson).catch(() => {});
    if (oldFile === null) await tools.removeEntry(filename).catch(() => {});
    else await writeText(tools, filename, oldFile).catch(() => {});
    throw e;
  }
  return { replaced: oldFile !== null };
}

/** Delete tools/<filename> and drop it from tools.json. Built-ins are refused. */
export async function removeTool(tools, filename) {
  checkFilename(filename);
  const { list } = await readList(tools);
  await writeText(tools, "tools.json", formatToolsJson(list.filter((f) => f !== filename)));
  await tools.removeEntry(filename).catch(() => {});
}
