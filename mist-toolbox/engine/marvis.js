// Ported from mist_disconnect_console.py lines 381-497.
// Marvis Troubleshoot text → the AP the client "used most of the time".

import {
  asArray, cleanApToken, foldToken, hexMac, looksLikeMac, nameMacSuffix,
} from "./util.js";

/** Flatten Marvis Troubleshoot payloads (results[].text, description, raw string). */
export function marvisTexts(marvis) {
  let obj = marvis;
  if (typeof marvis === "string") {
    const blob = marvis.trim();
    if (blob.startsWith("{") || blob.startsWith("[")) {
      try {
        obj = JSON.parse(blob);
      } catch {
        return [marvis];
      }
    } else {
      return marvis ? [marvis] : [];
    }
  }
  const texts = [];
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const row of asArray(obj.results || obj.insights || obj.data)) {
      for (const k of ["text", "description", "reason", "recommendation", "message"]) {
        if (row[k]) texts.push(String(row[k]));
      }
      if (row.ap) texts.push(`connected to ${row.ap}`);
      if (row.ap_name) texts.push(`connected to ${row.ap_name} most of the time`);
    }
    for (const k of ["text", "description", "reason", "recommendation"]) {
      if (obj[k]) texts.push(String(obj[k]));
    }
  } else if (Array.isArray(obj)) {
    for (const row of obj) {
      if (row && typeof row === "object" && !Array.isArray(row) && row.text) texts.push(String(row.text));
      else if (typeof row === "string") texts.push(row);
    }
  }
  return texts;
}

/** Pull the AP Marvis says the client 'connected to … most of the time'. */
export function parseMarvisApHints(marvis) {
  const texts = marvisTexts(marvis);
  const blob = texts.join("\n");
  let mostName = null;
  const names = [];
  const macs = [];

  const addName = (raw, most = false) => {
    const cand = cleanApToken(raw);
    if (!cand) return;
    if (most && !mostName) mostName = cand;
    if (!names.includes(cand)) names.push(cand);
    const h = looksLikeMac(cand);
    if (h && !macs.includes(h)) macs.push(h);
  };

  for (const m of blob.matchAll(/connected to\s+([\s\S]+?)\s+most of the time/gi)) {
    addName(m[1], true);
  }
  for (const m of blob.matchAll(
    /(?:was connected to|connected to|associated to|roamed to|on AP)\s+([A-Za-z0-9][A-Za-z0-9._:-]{2,80})/gi,
  )) {
    addName(m[1]);
  }
  for (const m of blob.matchAll(/(?:[0-9a-f]{2}[:\-]){5}[0-9a-f]{2}|[0-9a-f]{12}/gi)) {
    const h = hexMac(m[0]);
    if (h.length === 12 && !macs.includes(h)) macs.push(h);
  }
  return { mostName, names, macs, texts, blob };
}

export function matchInventory(inventory, { name = "", mac = "", text = "" } = {}) {
  if (!inventory || inventory.length === 0) return null;
  const macH = hexMac(mac);
  const nameN = (name || "").trim();
  const nameF = foldToken(nameN);
  let suf = nameN ? nameMacSuffix(nameN) : "";
  if (macH && macH.length >= 6 && !suf) suf = macH.slice(-6);
  const blob = text || "";
  const blobL = blob.toLowerCase();
  const blobF = foldToken(blob);

  const score = (dev) => {
    const dmac = hexMac(dev.mac);
    const dname = String(dev.name || "").trim();
    const dn = dname.toLowerCase();
    const df = foldToken(dname);
    let s = 0;
    if (macH && dmac === macH) s += 100;
    if (nameF && df === nameF) s += 90;
    if (nameN && dn === nameN.toLowerCase()) s += 90;
    if (nameF && df && (df.includes(nameF) || nameF.includes(df)) && Math.min(nameF.length, df.length) >= 8) s += 50;
    if (blob && dname && dname.length >= 4 && blobL.includes(dn)) s += 80;
    if (blobF && df && df.length >= 8 && blobF.includes(df)) s += 80;
    const dsuf = nameMacSuffix(dname);
    if (suf && suf.length >= 6 && (dmac.endsWith(suf) || dsuf === suf)) s += 75;
    if (blobF && dmac && dmac.length === 12 && blobF.includes(dmac)) s += 70;
    if (blobF && dmac.length >= 6 && blobF.includes(dmac.slice(-6)) && dsuf && blobF.includes(dsuf)) s += 65;
    return s;
  };

  // Python: ranked.sort(key=..., reverse=True) is stable and does NOT reverse
  // ties, so a plain descending comparator matches.
  const ranked = inventory.map((d) => [score(d), d]);
  ranked.sort((a, b) => b[0] - a[0]);
  if (ranked.length && ranked[0][0] >= 65) return ranked[0][1];
  return null;
}
