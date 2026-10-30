// Renders a downloaded .xlsx as an Excel-like HTML page, so the workbooks the
// tools save can be screenshotted next to the tools themselves. It reads only
// what lib/xlsx.js writes (inline strings, numbers, booleans, cellXfs with a
// font and a solid fill, column widths, a frozen header, tab colours, tables),
// which keeps it small and free of a spreadsheet dependency.

import { inflateRawSync } from "node:zlib";

/** Entries of a zip, by name. Stored and deflated entries only — all zip.js writes. */
function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  if (eocd < 0) throw new Error("not a zip");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    out[name] = (method === 8 ? inflateRawSync(raw) : raw).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const unxml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
const attr = (tag, name) => (tag.match(new RegExp(`\\s${name}="([^"]*)"`)) || [])[1];
const argb = (v) => (v && v.length === 8 ? `#${v.slice(2)}` : null);

function styles(xml) {
  const section = (name) => (xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)) || [, ""])[1];
  const fonts = [...section("fonts").matchAll(/<font>([\s\S]*?)<\/font>/g)].map(([, f]) => ({
    bold: /<b\/>/.test(f), color: argb(attr((f.match(/<color[^>]*>/) || [""])[0], "rgb")),
  }));
  const fills = [...section("fills").matchAll(/<fill>([\s\S]*?)<\/fill>/g)].map(([, f]) =>
    /patternType="solid"/.test(f) ? argb(attr((f.match(/<fgColor[^>]*>/) || [""])[0], "rgb")) : null);
  return [...section("cellXfs").matchAll(/<xf\b([^>]*?)(?:\/>|>([\s\S]*?)<\/xf>)/g)].map(([, a, inner = ""]) => ({
    ...fonts[Number(attr(a, "fontId")) || 0],
    fill: fills[Number(attr(a, "fillId")) || 0],
    border: Number(attr(a, "borderId")) > 0,
    center: /horizontal="center"/.test(inner),
    wrap: /wrapText="1"/.test(inner),
  }));
}

/** Parse an .xlsx buffer into { sheets: [{ name, tabColor, widths, rows, table }] }. */
export function readXlsx(buf) {
  const z = unzip(buf);
  const xfs = styles(z["xl/styles.xml"] || "");
  const names = [...z["xl/workbook.xml"].matchAll(/<sheet\b[^>]*>/g)].map(([t]) => unxml(attr(t, "name")));
  const sheets = names.map((name, i) => {
    const xml = z[`xl/worksheets/sheet${i + 1}.xml`] || "";
    const widths = [];
    for (const [t] of xml.matchAll(/<col\b[^>]*>/g)) widths[Number(attr(t, "min")) - 1] = Number(attr(t, "width"));
    const rows = [...xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)].map(([, ra, body]) => ({
      height: Number(attr(ra, "ht")) || 15,
      cells: [...body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(([, ca, inner = ""]) => {
        const ref = attr(ca, "r");
        const col = [...ref.replace(/\d+$/, "")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        const type = attr(ca, "t");
        const text = type === "inlineStr" ? unxml((inner.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [, ""])[1])
          : type === "b" ? ((inner.match(/<v>(.*?)<\/v>/) || [])[1] === "1" ? "TRUE" : "FALSE")
          : (inner.match(/<v>(.*?)<\/v>/) || [, ""])[1];
        return { col, text, kind: type === "inlineStr" ? "s" : type === "b" ? "b" : "n", style: xfs[Number(attr(ca, "s")) || 0] || {} };
      }),
    }));
    return {
      name,
      tabColor: argb(attr((xml.match(/<tabColor[^>]*>/) || [""])[0], "rgb")),
      frozen: /state="frozen"/.test(xml),
      filter: /<autoFilter/.test(xml) || /<tablePart/.test(xml),
      table: /<tablePart/.test(xml),
      widths,
      rows,
    };
  });
  return { sheets };
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const letter = (n) => { let s = ""; for (let i = n + 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

/**
 * One sheet as a full HTML page: title bar, formula bar, grid with column
 * letters and row numbers, and the sheet tabs with the active one selected.
 */
export function sheetPage(book, fileName, active, { maxRows = 24, width = 1280 } = {}) {
  const sh = book.sheets[active];
  const ncols = Math.max(sh.widths.length, ...sh.rows.map((r) => r.cells.length ? r.cells[r.cells.length - 1].col + 1 : 0));
  const px = (i) => Math.round((sh.widths[i] || 8.43) * 7 + 5);
  // Fill the window with empty columns the way Excel does.
  const colsPx = [];
  let used = 42;
  for (let i = 0; i < ncols || used < width; i += 1) { const w = i < ncols ? px(i) : 69; colsPx.push(w); used += w; }
  const rows = sh.rows.slice(0, maxRows);
  const blank = 3;

  const td = (c, r, i) => {
    const st = c?.style || {};
    const css = [];
    let fill = st.fill;
    if (!fill && sh.table && r > 0 && r % 2 === 1) fill = "#DDEBF7";
    if (fill) css.push(`background:${fill}`);
    if (st.color) css.push(`color:${st.color}`);
    if (st.bold) css.push("font-weight:700");
    if (st.center) css.push("text-align:center");
    else if (c && c.kind !== "s") css.push(`text-align:${c.kind === "b" ? "center" : "right"}`);
    if (st.border) css.push("border-color:#bfbfbf");
    const filter = r === 0 && sh.filter && i < ncols ? '<span class="dd">▾</span>' : "";
    const cls = [r === 0 && st.wrap ? "wr" : "", filter ? "flt" : ""].filter(Boolean).join(" ");
    return `<td${css.length ? ` style="${css.join(";")}"` : ""}${cls ? ` class="${cls}"` : ""}>${c ? esc(c.text) : ""}${filter}</td>`;
  };

  const body = rows.map((row, r) => {
    const byCol = new Map(row.cells.map((c) => [c.col, c]));
    return `<tr style="height:${Math.round(row.height * 4 / 3)}px"${r === 0 && sh.frozen ? ' class="fz"' : ""}><th>${r + 1}</th>`
      + colsPx.map((_, i) => td(byCol.get(i), r, i)).join("") + "</tr>";
  }).join("") + Array.from({ length: blank }, (_, k) =>
    `<tr style="height:20px"><th>${rows.length + k + 1}</th>${colsPx.map(() => "<td></td>").join("")}</tr>`).join("");

  const first = rows[0]?.cells[0]?.text ?? "";
  const tabs = book.sheets.map((s, i) =>
    `<span class="tab${i === active ? " on" : ""}"${s.tabColor ? ` style="--tc:${s.tabColor}"` : ""}>${esc(s.name)}</span>`).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0}
  body{width:${width}px;font:13.5px Calibri,Carlito,"Liberation Sans",Arial,sans-serif;color:#000;background:#fff;overflow:hidden}
  .title{background:#217346;color:#fff;display:flex;align-items:center;gap:12px;padding:0 14px;height:36px;font:13px "Segoe UI",system-ui,sans-serif}
  .title b{font-weight:600}
  .title .x{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:3px;background:#fff;color:#217346;font-weight:800;font-size:12px}
  .fx{display:flex;align-items:center;border-bottom:1px solid #d4d4d4;height:30px;font:13px "Segoe UI",system-ui,sans-serif;background:#fff}
  .fx .nm{width:90px;border-right:1px solid #d4d4d4;padding:0 8px;height:100%;display:flex;align-items:center}
  .fx .f{padding:0 10px;color:#666;font-style:italic;border-right:1px solid #d4d4d4;height:100%;display:flex;align-items:center}
  .fx .v{padding:0 10px;white-space:nowrap;overflow:hidden}
  .grid{overflow:hidden;width:${width}px}
  table{border-collapse:collapse;table-layout:fixed}
  th,td{border:1px solid #e1e1e1;padding:0 4px;white-space:nowrap;overflow:hidden;text-overflow:clip;vertical-align:bottom;position:relative}
  thead th{background:#f3f3f3;color:#444;font:12px "Segoe UI",system-ui,sans-serif;font-weight:400;height:22px;text-align:center;border-color:#d4d4d4}
  tbody th{background:#f3f3f3;color:#444;font:12px "Segoe UI",system-ui,sans-serif;font-weight:400;width:42px;text-align:center;border-color:#d4d4d4}
  thead th.sel,tbody tr:first-child th{background:#e1e1e1}
  td.wr{white-space:normal;line-height:1.1;vertical-align:middle}
  td.flt{padding-right:19px}
  tr.fz td,tr.fz th{border-bottom:2px solid #9b9b9b}
  .dd{position:absolute;right:2px;bottom:3px;width:15px;height:15px;font-size:10px;line-height:13px;text-align:center;
    background:#f3f3f3;color:#333;border:1px solid #9b9b9b;border-radius:2px}
  .tabs{display:flex;align-items:stretch;gap:0;background:#f3f3f3;border-top:1px solid #d4d4d4;height:30px;font:13px "Segoe UI",system-ui,sans-serif;padding-left:60px}
  .tab{padding:0 14px;display:flex;align-items:center;border-right:1px solid #d4d4d4;color:#333;box-shadow:inset 0 -3px 0 var(--tc,transparent)}
  .tab.on{background:#fff;color:#217346;font-weight:600;box-shadow:inset 0 -3px 0 var(--tc,#217346)}
</style></head><body>
<div class="title"><span class="x">X</span><b>${esc(fileName)}</b><span style="opacity:.8">— Excel</span></div>
<div class="fx"><span class="nm">A1</span><span class="f">fx</span><span class="v">${esc(first)}</span></div>
<div class="grid"><table><colgroup><col style="width:42px">${colsPx.map((w) => `<col style="width:${w}px">`).join("")}</colgroup>
<thead><tr><th></th>${colsPx.map((_, i) => `<th${i === 0 ? ' class="sel"' : ""}>${letter(i)}</th>`).join("")}</tr></thead>
<tbody>${body}</tbody></table></div>
<div class="tabs">${tabs}</div>
</body></html>`;
}
