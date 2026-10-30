// Ported from mist_disconnect_console.py lines 498-628 and 744-888.
// Which AP is "this client's AP", and that AP's channel-occupancy histogram.

import { matchInventory, parseMarvisApHints } from "./marvis.js";
import { rrmOccupancyStack } from "./rrm.js";
import {
  argMax, asRecord, bandGroup, formatMac, hexMac, isEmpty, mistDeviceId, num, pyGet,
  stackPcts, utilPct,
} from "./util.js";

// Standard 20 MHz 5 GHz channels the Radio Management "All" histogram uses
// (US UNII-2 Ext without weather-radar 120-128, plus UNII-3).
export const OCC_5_DEFAULT = [100, 104, 108, 112, 116, 132, 136, 140, 144, 149, 153, 157, 161, 165];
export const OCC_UNII1 = [36, 40, 44, 48];
export const OCC_UNII2 = [52, 56, 60, 64];
export const OCC_24 = [1, 6, 11];
export const OCC_6 = Array.from({ length: Math.ceil(233 / 4) }, (_, i) => 1 + i * 4);

/** Prefer Marvis 'connected to X most of the time', then longest session. */
export function pickDominantAp(sessions, stats, events, marvis, inventory = null) {
  const inv = inventory || [];
  const hints = parseMarvisApHints(marvis);
  let dwell = {};
  for (const s of sessions) {
    const ap = hexMac(s.ap);
    if (!ap) continue;
    dwell[ap] = (dwell[ap] || 0) + Number(s.duration || 0);
  }

  let source = "";
  let apMac = "";
  let apName = String(hints.mostName || "");
  let matched = null;
  let marvisUnmatched = "";
  const blob = String(hints.blob || "");

  if (hints.mostName || hints.names.length || hints.macs.length || blob) {
    if (hints.mostName) matched = matchInventory(inv, { name: String(hints.mostName), text: blob });
    if (!matched) matched = matchInventory(inv, { text: blob });
    if (!matched) {
      for (const n of hints.names || []) {
        matched = matchInventory(inv, { name: n, text: blob });
        if (matched) break;
      }
    }
    if (!matched) {
      for (const m of hints.macs || []) {
        matched = matchInventory(inv, { mac: m });
        if (matched) break;
      }
    }
    if (matched) {
      apMac = hexMac(matched.mac);
      apName = String(matched.name || apName);
      source = "marvis";
    } else if (hints.macs.length) {
      apMac = hints.macs[0];
      source = "marvis";
      apName = apName || String(hints.mostName || "");
    } else if (hints.mostName || hints.names.length) {
      marvisUnmatched = String(hints.mostName || hints.names[0]);
    }
  }

  let fallbackFrom = "";
  if (!apMac && !isEmpty(dwell)) {
    apMac = argMax(dwell);
    source = "sessions";
    fallbackFrom = "longest-session";
    matched = matchInventory(inv, { mac: apMac }) || matched;
    if (matched) apName = String(matched.name || apName);
  }

  if (!apMac) {
    const counts = {};
    for (const e of events) {
      const ap = hexMac(e.ap);
      if (ap) counts[ap] = (counts[ap] || 0) + 1;
    }
    if (!isEmpty(counts)) {
      apMac = argMax(counts);
      source = "events";
      fallbackFrom = "event-count";
      dwell = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)]));
      matched = matchInventory(inv, { mac: apMac }) || matched;
      if (matched) apName = String(matched.name || apName);
    }
  }

  if (!apMac) {
    apMac = hexMac((stats || {}).ap);
    source = "stats";
    fallbackFrom = "live client stats";
    matched = matchInventory(inv, { mac: apMac }) || matched;
    if (matched) apName = String(matched.name || apName);
  }

  const mentionedMacs = [...(hints.macs || [])];
  const total = Object.values(dwell).reduce((a, b) => a + b, 0) || 1;
  let band = "";
  for (const s of sessions) {
    if (hexMac(s.ap) === apMac && s.band) {
      band = String(s.band);
      break;
    }
  }
  if (!band) band = String((stats || {}).band || "5");

  const pretty = apName || (apMac ? formatMac(apMac) : "—");
  let note;
  if (source === "marvis") {
    const named = hints.mostName || pretty;
    note =
      `Marvis named ${named} as the AP this client used most of the time. ` +
      `Chart is that radio (${formatMac(apMac)}).`;
  } else if (marvisUnmatched) {
    note =
      `Marvis named ${marvisUnmatched}, but that name did not match a site AP in inventory. ` +
      `Chart is the ${fallbackFrom || "longest-session"} AP ${pretty}.`;
  } else if (hints.texts.length) {
    note =
      "Marvis did not name a recognizable site AP. " +
      `Chart is the ${fallbackFrom || "longest-session"} AP ${pretty}.`;
  } else {
    note =
      "Marvis Troubleshoot did not return an AP name. " +
      `Chart is the ${fallbackFrom || "longest-session"} AP ${pretty}.`;
  }

  return {
    apMac,
    apNameHint: apName,
    source: source || "unknown",
    dwellSeconds: apMac ? dwell[apMac] || 0 : 0,
    dwellShare: !isEmpty(dwell) && apMac ? (dwell[apMac] || 0) / total : 0,
    bandHint: band,
    marvisMentioned: source === "marvis",
    marvisAps: mentionedMacs,
    marvisName: hints.mostName || apName,
    deviceId: String((matched || {}).id || (apMac ? mistDeviceId(apMac) : "")),
    matchedDev: matched,
    selectionNote: note,
    fallback: source !== "marvis",
  };
}

export function radioFromDevice(dev, bandHint) {
  const rs = asRecord(dev.radio_stat) || {};
  const wanted = bandGroup(bandHint);
  const keys = { 24: "band_24", 5: "band_5", 6: "band_6" };
  const order = [keys[wanted] || "band_5", "band_5", "band_6", "band_24"];
  const seen = new Set();
  for (const key of order) {
    if (seen.has(key)) continue;
    seen.add(key);
    const rec = asRecord(rs[key]);
    if (rec && (rec.channel || rec.num_clients !== undefined || rec.power !== undefined)) {
      return [rec, key.replace("band_", "")];
    }
  }
  return [{}, wanted !== "unk" ? wanted : "5"];
}

/** Last-resort occupancy from live radio_stat when RRM scan is empty. */
export function servingChannelRow(radio, channel) {
  const site = utilPct(pyGet(radio, "util_rx_in_bss", radio.util_in_bss));
  let external =
    utilPct(pyGet(radio, "util_rx_other_bss", radio.util_other_bss)) + utilPct(radio.util_unknown_wifi);
  let nonWifi = utilPct(radio.util_non_wifi);
  if (site + external + nonWifi === 0) {
    nonWifi = Math.max(0, utilPct(radio.util_all) - utilPct(radio.util_tx));
  }
  const [s, e, n] = stackPcts(site, external, nonWifi);
  return {
    channel: Math.trunc(num(channel) || 0),
    site: s,
    external: e,
    nonWifi: n,
    serving: true,
  };
}

/** Portal 'All' for a 5 GHz radio on UNII-2 Ext/3 shows 100-165, including zeros. */
export function padBandChannels(band, servingCh, have) {
  const extra = [];
  if (OCC_5_DEFAULT.includes(servingCh) || band === "5") extra.push(...OCC_5_DEFAULT);
  if (OCC_UNII1.includes(servingCh)) extra.push(...OCC_UNII1);
  if (OCC_UNII2.includes(servingCh)) extra.push(...OCC_UNII2);
  if (band === "24" || OCC_24.includes(servingCh)) extra.push(...OCC_24);
  const out = [];
  const seen = new Set();
  for (const ch of [...have, ...extra]) {
    if (ch && !seen.has(ch)) {
      seen.add(ch);
      out.push(ch);
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

/** In-BSS airtime of a site AP (TX + our BSS RX). This is the portal 'Site APs' component. */
export function siteAirtime(radio) {
  if (isEmpty(radio)) return 0;
  const tx = utilPct(radio.util_tx);
  const inn = utilPct(pyGet(radio, "util_rx_in_bss", radio.util_in_bss));
  const air = Math.min(100, tx + inn);
  if (air) return air;
  const allu = utilPct(radio.util_all);
  const nw = utilPct(radio.util_non_wifi);
  const oth = utilPct(radio.util_rx_other_bss) + utilPct(radio.util_unknown_wifi);
  const leftover = Math.max(0, allu - nw - oth);
  if (leftover) return leftover;
  // Radio is up but counters empty — beacons still occupy (portal ~9% on a 0-client AP).
  if (radio.channel !== undefined && radio.channel !== null && radio.power !== undefined && radio.power !== null) {
    return 8;
  }
  return 0;
}

/**
 * Per-channel Site AP occupancy from every site AP's radio_stat, including the serving AP.
 *
 * Radio Management orange bars are 802.11 airtime from APs that belong to this site.
 * RRM considerations often omit that on 'clean' channels; inventory fills them.
 */
export function siteAirtimeByChannel(inventory, band) {
  const sums = {};
  const want = bandGroup(band);
  for (const d of inventory || []) {
    const [radio, b] = radioFromDevice(d, band);
    if (want !== "unk" && !["unk", want].includes(bandGroup(b))) continue;
    const ch = Math.trunc(num(radio.channel) || 0);
    if (!ch) continue;
    sums[ch] = Math.min(100, (sums[ch] || 0) + siteAirtime(radio));
  }
  return sums;
}

/** Histogram = this AP's scan (non-Wi-Fi + External) plus Site AP airtime from inventory. */
export function channelsFromRrm(rows, servingCh, servingRadio, band = "5", siteChannels = null) {
  const servingN = Math.trunc(num(servingCh) || 0);
  const siteAir = siteChannels || {};
  const byCh = new Map();
  for (const row of rows) {
    const ch = Math.trunc(num(pyGet(row, "channel", pyGet(row, "chan", row.ch))) || 0);
    if (!ch) continue;
    let [s, e, n] = rrmOccupancyStack(row, Object.prototype.hasOwnProperty.call(siteAir, ch));
    if (s === 0 && siteAir[ch]) [s, e, n] = stackPcts(siteAir[ch], e, n);
    byCh.set(ch, { channel: ch, site: s, external: e, nonWifi: n, serving: ch === servingN });
  }
  for (const [chKey, air] of Object.entries(siteAir)) {
    const ch = Number(chKey);
    if (!byCh.has(ch)) {
      byCh.set(ch, { channel: ch, site: air, external: 0, nonWifi: 0, serving: ch === servingN });
    } else if (byCh.get(ch).site === 0 && air) {
      const cur = byCh.get(ch);
      const [s, e, n] = stackPcts(air, cur.external, cur.nonWifi);
      cur.site = s;
      cur.external = e;
      cur.nonWifi = n;
    }
  }
  for (const ch of padBandChannels(band, servingN, [...byCh.keys()])) {
    if (!byCh.has(ch)) {
      byCh.set(ch, { channel: ch, site: 0, external: 0, nonWifi: 0, serving: ch === servingN });
    } else {
      byCh.get(ch).serving = ch === servingN;
    }
  }
  const out = [...byCh.keys()].sort((a, b) => a - b).map((k) => byCh.get(k));
  if (servingN && !byCh.has(servingN) && servingRadio) {
    out.push(servingChannelRow(servingRadio, servingN));
    out.sort((a, b) => a.channel - b.channel);
  }
  return out;
}
