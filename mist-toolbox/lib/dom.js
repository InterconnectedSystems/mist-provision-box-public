// Shared rendering helpers. These were private to console.js; the toolbox needs
// them in every tool, so they live here and are imported rather than copied.

/** HTML-escape. Every interpolation of API-sourced text must go through this —
 *  tests/policy.test.js greps for unescaped template holes. */
export function esc(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&" + "amp;")
    .replace(/</g, "&" + "lt;")
    .replace(/>/g, "&" + "gt;")
    .replace(/"/g, "&" + "quot;")
    .replace(/'/g, "&#39;");
}

export const $ = (id) => document.getElementById(id);

export function fmtMac(m) {
  const n = (m || "").replace(/[^0-9a-f]/gi, "").toLowerCase();
  return n.length === 12 ? n.match(/.{2}/g).join(":") : String(m || "");
}

export function fmtTime(ts) {
  if (ts === null || ts === undefined || ts === "") return "—";
  const n = Number(ts);
  if (!Number.isFinite(n)) return String(ts);
  const ms = n > 1e11 ? n : n * 1000;
  try {
    return new Date(ms).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch {
    return String(ts);
  }
}

/** UTC, matching site-wifi-clients.py's epoch_to_utc output format. */
export function epochToUtc(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || !n) return "";
  const ms = n > 1e11 ? n : n * 1000;
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

export function fmtBytes(n) {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

/** Render an array-of-objects as a bounded preview table. */
export function previewTable(columns, rows, limit = 200) {
  const shown = rows.slice(0, limit);
  const head = columns.map((c) => `<th>${esc(c.header)}</th>`).join("");
  const body = shown.map((r) => "<tr>" + columns.map((c, i) => {
    const v = Array.isArray(r) ? r[i] : r[c.key ?? i];
    return `<td>${esc(v === null || v === undefined ? "" : v)}</td>`;
  }).join("") + "</tr>").join("");
  const more = rows.length > shown.length
    ? `<p class="subtle" style="font-size:12px;margin:.6rem 0 0">Showing ${shown.length} of ${rows.length} rows — the download has all of them.</p>`
    : "";
  return `<div class="res-scroll"><table class="ap-table"><thead><tr>${head}</tr></thead>`
    + `<tbody>${body}</tbody></table></div>${more}`;
}
