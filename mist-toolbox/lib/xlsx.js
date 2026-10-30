// Styled multi-sheet .xlsx generation, replacing openpyxl and xlsxwriter.
//
// The five Python scripts between them need: a filled bold header row, frozen
// panes, autofilter, computed column widths, Excel Tables with a style, tab
// colours, and conditional row fills. That is a closed set, so this writes the
// OOXML directly rather than carrying a megabyte of third-party bundle — which
// also keeps the policy test's absolute console.* ban intact.
//
// openpyxl's formula-injection guard is preserved structurally: every text cell
// is written as t="inlineStr", which Excel never evaluates, so a value opening
// with "=" or "@" stays text without needing to be detected.

import { zip } from "./zip.js";

/** Control characters Excel rejects outright — openpyxl's ILLEGAL_CHARACTERS_RE. */
const ILLEGAL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

/** Named cell styles, by cellXfs index in styles.xml below. */
export const STYLE = {
  default: 0, header: 1, body: 2, wrap: 3,
  green: 4, blue: 5, yellow: 6, red: 7, bold: 8,
};

const ACCENT = "FF1F4E79";   // the header fill both mist_ip_blocks.py and
                             // mist_switch_port_inventory.py used

export function colLetter(n) {
  let s = "";
  for (let i = n + 1; i > 0; i = Math.floor((i - 1) / 26)) {
    s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  }
  return s;
}

const esc = (v) => String(v).replace(ILLEGAL, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

/** Excel forbids []:*?/\ in sheet names and caps them at 31 characters. */
function safeSheetName(name, taken) {
  let base = String(name || "Sheet").replace(/[[\]:*?/\\]/g, "-").slice(0, 31) || "Sheet";
  let out = base;
  for (let i = 2; taken.has(out.toLowerCase()); i += 1) {
    out = `${base.slice(0, 31 - String(i).length - 1)}-${i}`;
  }
  taken.add(out.toLowerCase());
  return out;
}

function cell(ref, value, style) {
  if (value === null || value === undefined || value === "") {
    return style ? `<c r="${ref}" s="${style}"/>` : "";
  }
  const s = style ? ` s="${style}"` : "";
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
  if (typeof value === "boolean") return `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

/**
 * One sheet.
 *
 * @param {string} name
 * @param {Array<{header: string, key?: string, width?: number, wrap?: boolean}>} columns
 * @param {Array<object|Array>} rows   objects keyed by column.key, or positional arrays.
 *   A row may carry `__style` naming a STYLE key to fill that whole row.
 * @param {{freeze?: {row: number, col: number}|null, autofilter?: boolean,
 *          table?: string|null, tabColor?: string|null}} [opts]
 */
export function sheet(name, columns, rows, opts = {}) {
  return { name, columns, rows, ...opts };
}

function sheetXml(spec, tableId) {
  const cols = spec.columns;
  const rows = spec.rows || [];
  const lastCol = colLetter(Math.max(0, cols.length - 1));
  const lastRow = rows.length + 1;
  const ref = `A1:${lastCol}${lastRow}`;
  // A Table carries its own filter dropdowns; declaring both is invalid.
  const wantsFilter = spec.autofilter !== false && !spec.table;
  const freeze = spec.freeze === null ? null : (spec.freeze || { row: 1, col: 0 });

  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">');
  if (spec.tabColor) out.push(`<sheetPr><tabColor rgb="FF${spec.tabColor}"/></sheetPr>`);
  out.push(`<dimension ref="${ref}"/>`);

  if (freeze && (freeze.row || freeze.col)) {
    const topLeft = `${colLetter(freeze.col || 0)}${(freeze.row || 0) + 1}`;
    const split = [];
    if (freeze.col) split.push(`xSplit="${freeze.col}"`);
    if (freeze.row) split.push(`ySplit="${freeze.row}"`);
    out.push('<sheetViews><sheetView workbookViewId="0">'
      + `<pane ${split.join(" ")} topLeftCell="${topLeft}" activePane="bottomRight" state="frozen"/>`
      + '</sheetView></sheetViews>');
  } else {
    out.push('<sheetViews><sheetView workbookViewId="0"/></sheetViews>');
  }
  out.push('<sheetFormatPr defaultRowHeight="15"/>');

  // Column widths: honour an explicit width, else size to the widest value.
  out.push("<cols>");
  cols.forEach((c, i) => {
    let w = c.width;
    if (!w) {
      w = String(c.header || "").length;
      const key = c.key ?? i;
      for (const r of rows) {
        const v = Array.isArray(r) ? r[i] : r[key];
        if (v !== null && v !== undefined) w = Math.max(w, String(v).length);
      }
      w = Math.min(60, Math.max(8, w + 2));
    }
    out.push(`<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`);
  });
  out.push("</cols><sheetData>");

  out.push(`<row r="1" ht="28" customHeight="1">`
    + cols.map((c, i) => cell(`${colLetter(i)}1`, c.header ?? "", STYLE.header)).join("")
    + "</row>");

  rows.forEach((r, n) => {
    const rowNum = n + 2;
    const rowStyle = r && !Array.isArray(r) && r.__style ? STYLE[r.__style] : undefined;
    const cells = cols.map((c, i) => {
      const v = Array.isArray(r) ? r[i] : r[c.key ?? i];
      const st = rowStyle ?? (c.wrap ? STYLE.wrap : STYLE.body);
      return cell(`${colLetter(i)}${rowNum}`, v, st);
    }).join("");
    out.push(`<row r="${rowNum}">${cells}</row>`);
  });

  out.push("</sheetData>");
  if (wantsFilter && rows.length) out.push(`<autoFilter ref="${ref}"/>`);
  out.push('<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>');
  if (spec.table) out.push(`<tableParts count="1"><tablePart r:id="rId1"/></tableParts>`);
  out.push("</worksheet>");
  return out;
}

function tableXml(spec, id) {
  const cols = spec.columns;
  const ref = `A1:${colLetter(cols.length - 1)}${(spec.rows || []).length + 1}`;
  const name = String(spec.table).replace(/[^A-Za-z0-9_]/g, "_");
  // Table column names must be unique and non-empty or Excel repairs the file.
  const seen = new Set();
  const names = cols.map((c, i) => {
    let h = String(c.header || `Column${i + 1}`);
    while (seen.has(h.toLowerCase())) h += "_";
    seen.add(h.toLowerCase());
    return h;
  });
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${id}"`
    + ` name="${esc(name)}" displayName="${esc(name)}" ref="${ref}" totalsRowShown="0">`
    + `<autoFilter ref="${ref}"/>`
    + `<tableColumns count="${cols.length}">`
    + names.map((h, i) => `<tableColumn id="${i + 1}" name="${esc(h)}"/>`).join("")
    + "</tableColumns>"
    + '<tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0"'
    + ' showRowStripes="1" showColumnStripes="0"/></table>';
}

const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="3">'
  + '<font><sz val="11"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="11"/><name val="Calibri"/></font>'
  + '</fonts>'
  + '<fills count="7">'
  + '<fill><patternFill patternType="none"/></fill>'
  + '<fill><patternFill patternType="gray125"/></fill>'
  + `<fill><patternFill patternType="solid"><fgColor rgb="${ACCENT}"/><bgColor indexed="64"/></patternFill></fill>`
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFC6EFCE"/><bgColor indexed="64"/></patternFill></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFFFEB9C"/><bgColor indexed="64"/></patternFill></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/><bgColor indexed="64"/></patternFill></fill>'
  + '</fills>'
  + '<borders count="2"><border/>'
  + '<border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right>'
  + '<top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom></border>'
  + '</borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="9">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
  + '<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/>'
  + '<xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/>'
  + '<xf numFmtId="0" fontId="0" fillId="5" borderId="0" xfId="0" applyFill="1"/>'
  + '<xf numFmtId="0" fontId="0" fillId="6" borderId="0" xfId="0" applyFill="1"/>'
  + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '</cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

/**
 * Build the .xlsx as a Blob.
 * @param {Array<ReturnType<typeof sheet>>} sheets
 */
export async function workbook(sheets) {
  const specs = sheets.filter(Boolean);
  if (!specs.length) throw new Error("A workbook needs at least one sheet.");
  const taken = new Set();
  for (const s of specs) s.name = safeSheetName(s.name, taken);

  const entries = [];
  const types = [];
  const wbSheets = [];
  const wbRels = [];
  let tableId = 0;

  specs.forEach((s, i) => {
    const n = i + 1;
    entries.push({ name: `xl/worksheets/sheet${n}.xml`, data: sheetXml(s, n) });
    types.push(`<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
    wbSheets.push(`<sheet name="${esc(s.name)}" sheetId="${n}" r:id="rId${n}"/>`);
    wbRels.push(`<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`);
    if (s.table) {
      tableId += 1;
      entries.push({ name: `xl/tables/table${tableId}.xml`, data: tableXml(s, tableId) });
      entries.push({
        name: `xl/worksheets/_rels/sheet${n}.xml.rels`,
        data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
          + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table${tableId}.xml"/>`
          + "</Relationships>",
      });
      types.push(`<Override PartName="/xl/tables/table${tableId}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>`);
    }
  });

  const stylesRid = `rId${specs.length + 1}`;
  entries.unshift(
    {
      name: "[Content_Types].xml",
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + types.join("") + "</Types>",
    },
    {
      name: "_rels/.rels",
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        + "</Relationships>",
    },
    {
      name: "xl/workbook.xml",
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
        + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + `<sheets>${wbSheets.join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + wbRels.join("")
        + `<Relationship Id="${stylesRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
        + "</Relationships>",
    },
    { name: "xl/styles.xml", data: STYLES_XML },
  );

  return zip(entries, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}
