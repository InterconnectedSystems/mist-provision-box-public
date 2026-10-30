// Ported from mist_disconnect_console.py lines 2386-2486.
// The RCA finding: one primary cause, the supporting notes, and every ranked
// correlation card.

import {
  buildCorrelations, callCorrelations, radioEventCorrelations, rfOccupancyCorrelations,
} from "./correlate.js";
import {
  dedupeCorrelations, describeReason, isEmpty, rssiBand, snrBand, utilPct,
} from "./util.js";

export function buildVerdict(
  stats, events, sessions, apRadio = null, radioEvents = null, calls = null, radioStore = null,
) {
  const notes = [];
  const cors = buildCorrelations(stats, events, sessions);
  cors.push(...rfOccupancyCorrelations(apRadio, stats));
  cors.push(...radioEventCorrelations(radioEvents || [], events, sessions, stats, apRadio, radioStore));
  cors.push(...callCorrelations(calls || [], events, sessions, stats, radioEvents || [], apRadio, radioStore));
  const rssi = (stats || {}).rssi;
  const snr = (stats || {}).snr;
  const rb = rssiBand(rssi ?? null);
  const sb = snrBand(snr ?? null);
  if (rb === "crit") notes.push(`RSSI ${rssi} dBm is critically weak — coverage or obstruction.`);
  else if (rb === "warn") notes.push(`RSSI ${rssi} dBm is marginal (target ≥ −65 dBm).`);
  if (sb === "crit") notes.push(`SNR ${snr} dB is critically low — noise or interference likely.`);
  else if (sb === "warn") notes.push(`SNR ${snr} dB is only fair (target ≥ 25 dB).`);

  const deauth = events.filter(
    (e) => e.type.toUpperCase().includes("DEAUTH") || e.type.toUpperCase().includes("DISASSOC"),
  );
  const dhcp = events.filter((e) => e.type.toUpperCase().includes("DHCP") && e.negative);
  const auth = events.filter(
    (e) =>
      e.negative &&
      (e.type.toUpperCase().includes("AUTH") || e.type.toUpperCase().includes("ASSOC")) &&
      !e.type.toUpperCase().includes("DEAUTH") &&
      !e.type.toUpperCase().includes("DISASSOC"),
  );
  const roam = events.filter((e) => e.type.toUpperCase().includes("ROAM"));
  if (deauth.length) {
    // Python set() of reason strings — order is arbitrary there, so sort for a
    // stable note across runs and across the two implementations.
    const reasons = [...new Set(deauth.map((e) => describeReason(e.reason)).filter(Boolean))].sort();
    notes.push(
      `${deauth.length} deauth/disassoc event(s)` +
        (reasons.length ? `: ${reasons.join("; ")}` : "") +
        ".",
    );
  }
  if (dhcp.length) notes.push(`${dhcp.length} DHCP failure(s) after association — L3 / gateway.`);
  if (auth.length) notes.push(`${auth.length} authentication/association failure(s).`);
  if (roam.length >= 4) {
    notes.push(`${roam.length} roam events in the window — sticky client or coverage holes.`);
  }
  const short = sessions.filter((s) => s.duration && s.duration > 0 && s.duration < 60);
  if (short.length >= 2) notes.push(`${short.length} sessions lasted under 60s — unstable association.`);
  const retries = (stats || {}).txRetries;
  if (retries !== null && retries !== undefined && retries >= 80) {
    notes.push(`${retries} TX retries — airtime contention or a dirty channel.`);
  }

  const radio = (apRadio || {}).radio || {};
  const servingOcc = (((apRadio || {}).channels) || []).find((c) => c.serving) || null;
  let nw = (servingOcc || {}).nonWifi;
  if (nw === null || nw === undefined) nw = !isEmpty(radio) ? utilPct(radio.utilNonWifi) : 0;
  if (nw >= 25) {
    const ch = (servingOcc || {}).channel || radio.channel;
    notes.push(`Serving AP channel ${ch} has ${nw}% non-Wi-Fi occupancy.`);
  }

  const radioHits = cors.filter((c) => String(c.id || "").startsWith("radio-"));
  const radarHits = radioHits.filter((c) => String(c.id || "").startsWith("radio-radar"));
  if (radarHits.length) {
    notes.push(
      `${radarHits.length} Post radar / DFS event(s) on APs this client was associated to in this window.`,
    );
  } else if (radioHits.length) {
    notes.push(`${radioHits[0].title}.`);
  }
  const callHits = cors.filter((c) => String(c.id || "").startsWith("call-"));
  if (callHits.length) notes.push(`${callHits[0].title}.`);
  const teamsPoor = (calls || []).filter((c) => c.teams && c.poor);
  if (teamsPoor.length && !callHits.length) {
    notes.push(`${teamsPoor.length} poor Microsoft Teams call(s) in the last 7 days.`);
  }

  const rank = { crit: 0, warn: 1, info: 2 };
  const conf = { high: 0, medium: 1, low: 2 };
  const pick = (m, k) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : 9);
  cors.sort(
    (a, b) =>
      (a.highlight ? 0 : 1) - (b.highlight ? 0 : 1) ||
      pick(rank, a.severity) - pick(rank, b.severity) ||
      pick(conf, a.confidence) - pick(conf, b.confidence),
  );
  const ranked = dedupeCorrelations(cors);
  for (const c of ranked) {
    if (c.severity === "crit" && c.confidence === "high") {
      if (!notes.some((n) => n.includes(c.title.slice(0, 18)))) notes.push(c.title);
    }
  }
  let primary = "No dominant failure signature — review the timeline.";
  if (ranked.length && ["crit", "warn"].includes(ranked[0].severity)) primary = ranked[0].title;
  else if (rb === "crit" || sb === "crit") primary = "RF: weak signal or high noise";
  else if (auth.length) primary = "Authentication / association failure";
  else if (dhcp.length) primary = "DHCP / IP services after join";
  else if (deauth.length) primary = "Repeated disconnects — see reason codes";
  if (!notes.length) notes.push("RF metrics in range and no clustered failure events.");
  return { primaryCause: primary, notes, correlations: ranked };
}
