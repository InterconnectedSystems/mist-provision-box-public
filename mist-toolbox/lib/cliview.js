// Turns Conductor responses into terminal-style text, and diffs two such texts
// line by line and field by field.
//
// The REST API hands back either the CLI's own text (kept verbatim, minus any
// ANSI colour codes) or JSON. JSON is laid out the way the SSR/FRR CLI lays
// out `show` output: a list of records becomes an aligned table with a dashed
// rule under the header, a flat record becomes aligned "key  value" lines,
// and nesting becomes indented sections. So a BGP summary's peers map —
// {"10.0.0.1": {...}, "10.0.0.2": {...}} — reads as a neighbor table rather
// than as dotted paths with IP addresses run through them.
//
// DOM-free so it can be tested in Node; the SSR tool does the HTML.

import { SequenceMatcher } from "./diff.js";

const INDENT = "  ";
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

const isScalar = (v) => v === null || v === undefined || typeof v !== "object";
const isFlatRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
  && Object.values(v).every((x) => isScalar(x) && !(typeof x === "string" && x.includes("\n")));

function scalar(v) {
  if (v === null || v === undefined || v === "") return "-";
  return String(v);
}

/** Verbatim CLI text: unify line endings, drop colour codes and trailing blank lines. */
export function cleanText(s) {
  return String(s).replace(ANSI, "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
}

/** An aligned table with a dashed rule under the header. */
export function table(columns, rows) {
  const cells = rows.map((r) => columns.map((c) => scalar(r[c])));
  const widths = columns.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i].length)));
  const line = (vals) => vals.map((v, i) => v.padEnd(widths[i])).join("  ").replace(/\s+$/, "");
  return [line(columns), line(widths.map((w) => "-".repeat(w))), ...cells.map(line)];
}

function columnsOf(records) {
  const cols = [];
  for (const r of records) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  return cols;
}

function keyValues(entries) {
  const width = Math.max(...entries.map(([k]) => k.length));
  return entries.map(([k, v]) => `${k.padEnd(width)}  ${scalar(v)}`.replace(/\s+$/, ""));
}

function indent(lines, by = INDENT) {
  return lines.map((l) => (l ? by + l : l));
}

/** Render any JSON value as terminal lines. */
function render(value) {
  if (typeof value === "string") return cleanText(value).split("\n");
  if (isScalar(value)) return [scalar(value)];

  if (Array.isArray(value)) {
    if (!value.length) return ["(none)"];
    if (value.every(isScalar)) return value.map((v) => (typeof v === "string" ? cleanText(v) : scalar(v)));
    if (value.every(isFlatRecord)) return table(columnsOf(value), value);
    const out = [];
    value.forEach((item, i) => {
      if (i) out.push("");
      out.push(`[${i}]`, ...indent(render(item)));
    });
    return out;
  }

  const entries = Object.entries(value);
  if (!entries.length) return ["(none)"];
  // A wrapper around one block of CLI text: show just the text.
  if (entries.length === 1 && typeof entries[0][1] === "string" && entries[0][1].includes("\n")) {
    return render(entries[0][1]);
  }
  // A map of records keyed by name/address: one table, the key as first column.
  const vals = entries.map(([, v]) => v);
  if (entries.length > 1 && vals.every(isFlatRecord)) {
    const rows = entries.map(([k, v]) => ({ name: k, ...v }));
    return table(columnsOf(rows), rows);
  }

  const flat = entries.filter(([, v]) => isScalar(v) && !(typeof v === "string" && v.includes("\n")));
  const nested = entries.filter((e) => !flat.includes(e));
  const out = flat.length ? keyValues(flat) : [];
  for (const [k, v] of nested) {
    if (out.length) out.push("");
    out.push(`${k}:`, ...indent(render(v)));
  }
  return out;
}

/**
 * Terminal text for one check's payload. Per-node checks arrive as
 * {node: payload}; each node gets a banner the way the CLI separates nodes.
 */
export function toCliText(payload, { perNode = false } = {}) {
  if (perNode && payload && typeof payload === "object" && !Array.isArray(payload)) {
    const parts = Object.entries(payload).map(([node, v]) => [`==== Node: ${node} ====`, ...render(v)].join("\n"));
    return parts.join("\n\n");
  }
  return render(payload).join("\n");
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/** Lines compare equal when only their spacing differs: tables re-pad. */
const lineKey = (l) => (/^[\s=-]+$/.test(l) && /[=-]{3}/.test(l)
  ? "\u0000rule"          // a table's dashed rule: its width follows the data
  : l.trim().replace(/\s+/g, " "));

/**
 * Field-level diff of two lines: whitespace-separated fields are compared,
 * spacing is kept for display. Returns [preSegs, postSegs] of [text, hot].
 */
export function fieldDiff(a, b) {
  const ta = a.split(/(\s+)/);
  const tb = b.split(/(\s+)/);
  const fieldsA = ta.map((t, i) => [t, i]).filter(([t]) => t && !/^\s+$/.test(t));
  const fieldsB = tb.map((t, i) => [t, i]).filter(([t]) => t && !/^\s+$/.test(t));
  const hotA = new Set();
  const hotB = new Set();
  const sm = new SequenceMatcher(fieldsA.map(([t]) => t), fieldsB.map(([t]) => t));
  for (const [tag, i1, i2, j1, j2] of sm.getOpcodes()) {
    if (tag === "equal") continue;
    for (let i = i1; i < i2; i += 1) hotA.add(fieldsA[i][1]);
    for (let j = j1; j < j2; j += 1) hotB.add(fieldsB[j][1]);
  }
  const segs = (tokens, hot) => merge(tokens.map((t, i) => [t, hot.has(i)]).filter(([t]) => t));
  return [segs(ta, hotA), segs(tb, hotB)];
}

function merge(segs) {
  const out = [];
  for (const [t, h] of segs) {
    const last = out[out.length - 1];
    if (last && last[1] === h) last[0] += t;
    else out.push([t, h]);
  }
  return out;
}

/**
 * Side-by-side rows for two terminal texts.
 * Each row: { kind: "same"|"changed"|"removed"|"added",
 *             pre: segs|null, post: segs|null }  where segs = [[text, hot], …].
 */
export function diffText(preText, postText) {
  const a = preText ? preText.split("\n") : [];
  const b = postText ? postText.split("\n") : [];
  const rows = [];
  const plain = (l) => [[l, false]];
  const sm = new SequenceMatcher(a.map(lineKey), b.map(lineKey));
  for (const [tag, i1, i2, j1, j2] of sm.getOpcodes()) {
    if (tag === "equal") {
      for (let k = 0; k < i2 - i1; k += 1) rows.push({ kind: "same", pre: plain(a[i1 + k]), post: plain(b[j1 + k]) });
      continue;
    }
    const n = Math.max(i2 - i1, j2 - j1);
    for (let k = 0; k < n; k += 1) {
      const la = i1 + k < i2 ? a[i1 + k] : null;
      const lb = j1 + k < j2 ? b[j1 + k] : null;
      if (la !== null && lb !== null) {
        const [pre, post] = fieldDiff(la, lb);
        rows.push({ kind: "changed", pre, post });
      } else if (la !== null) {
        rows.push({ kind: "removed", pre: [[la, true]], post: null });
      } else {
        rows.push({ kind: "added", pre: null, post: [[lb, true]] });
      }
    }
  }
  return rows;
}

export const changedLines = (rows) => rows.filter((r) => r.kind !== "same").length;
