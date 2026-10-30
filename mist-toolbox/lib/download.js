// Hands a generated file to the browser's download list.
//
// A Blob URL plus a programmatic <a download> click is enough, and needs no
// "downloads" permission — so manifest.json keeps an absent `permissions`
// array. The file lands in the browser's normal download list either way,
// which is the point.

/**
 * @param {Blob} blob
 * @param {string} filename
 */
export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = safeName(filename);
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the download a tick to start before the URL is revoked.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Strip path separators and characters Windows rejects in a filename. */
export function safeName(name) {
  return String(name || "download")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 200) || "download";
}

/** `mist_ssids_Acme_Corp_20261008_142530.xlsx` — the Python naming convention. */
export function stampedName(prefix, label, ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const slug = String(label || "org").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  return safeName(`${prefix}_${slug}_${stamp}.${ext}`);
}

/** CSV with CRLF and Excel-safe quoting — used by the SSR diff export. */
export function toCsv(header, rows) {
  const q = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(q).join(",")).join("\r\n") + "\r\n";
}
