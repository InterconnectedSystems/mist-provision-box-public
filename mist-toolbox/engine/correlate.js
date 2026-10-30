// Ported from mist_disconnect_console.py lines 890-948, 1766-1961, 1970-2172, 2185-2384.
// Every correlation card the dashboard shows, in the order the Python builds them.

import { callOpenAt, qualityPoor } from "./calls.js";
import { expandClientAps } from "./normalize.js";
import {
  apNameFor, clientApAt, clientDrops, isRadarEvent, powerChanged, radarFact,
  radarHitsThisClient, sameApMac,
} from "./radar.js";
import { RadioEventStore } from "./rrm.js";
import {
  DISRUPTIVE_RADIO, MAX_RADAR_CORRELATIONS, PINGPONG_MIN, WINDOW_CLUSTER_S,
  WINDOW_DHCP_S, WINDOW_RADIO_DFS_S, WINDOW_RADIO_RRM_S,
  bandGroup, dedupeCorrelations, describeReason, epochS, formatMac, hexMac, isEmpty,
  num, pyFloatStr, pyGet, pyRound, rssiBand, snrBand, uniqueAps, utilPct,
} from "./util.js";

const dash = (v) => (v === null || v === undefined ? "—" : v);

export function rfOccupancyCorrelations(apRadio, stats) {
  const out = [];
  if (isEmpty(apRadio) || apRadio.unavailable) return out;
  const radio = apRadio.radio || {};
  const channels = apRadio.channels || [];
  const serving = channels.find((c) => c.serving) || null;
  const ch = (serving || {}).channel || radio.channel;
  let nw = (serving || {}).nonWifi;
  if (nw === null || nw === undefined) nw = utilPct(radio.utilNonWifi);
  let ext = (serving || {}).external;
  if (ext === null || ext === undefined) {
    ext = utilPct(radio.utilRxOtherBss) + utilPct(radio.utilUnknownWifi);
  }
  let site = (serving || {}).site;
  if (site === null || site === undefined) site = utilPct(radio.utilRxInBss);
  const name = apRadio.apName || formatMac(apRadio.apMac || "");
  if (nw >= 25) {
    out.push({
      id: "ap-nonwifi",
      title: "Non-Wi-Fi interference on the serving AP channel",
      evidence:
        `AP ${name} sees ${nw}% non-Wi-Fi occupancy on channel ${ch} ` +
        "(Radio Management 20-min scan). Frames collide with energy that is not 802.11 — " +
        "radar, video, BLE, or industrial interferers — which matches high TX retries " +
        "while RSSI stays usable.",
      confidence: nw >= 40 ? "high" : "medium",
      severity: nw >= 40 ? "crit" : "warn",
    });
  }
  if (ext >= 30 && nw < 40) {
    out.push({
      id: "ap-external-cci",
      title: "External AP occupancy (CCI / hidden node)",
      evidence:
        `AP ${name} channel ${ch} has ${ext}% occupancy from other BSS (external APs) ` +
        `and ${site}% from site APs. Foreign BSSIDs on this channel cause retries without a coverage hole.`,
      confidence: "medium",
      severity: "warn",
    });
  }
  const hot = channels.filter((c) => !c.serving && pyGet(c, "nonWifi", 0) >= 50);
  if (hot.length && ch) {
    // Python min() keeps the first of equal distances.
    let nearest = hot[0];
    let best = Math.abs(Math.trunc(hot[0].channel) - Math.trunc(ch));
    for (const c of hot.slice(1)) {
      const d = Math.abs(Math.trunc(c.channel) - Math.trunc(ch));
      if (d < best) {
        best = d;
        nearest = c;
      }
    }
    if (Math.abs(Math.trunc(nearest.channel) - Math.trunc(ch)) <= 16) {
      out.push({
        id: "ap-adj-nonwifi",
        title: "Adjacent-channel non-Wi-Fi energy",
        evidence:
          `Channel ${nearest.channel} shows ${nearest.nonWifi}% non-Wi-Fi next to serving channel ${ch}. ` +
          "Bleed and AGC pumping on the client can look like a dirty serving channel.",
        confidence: "medium",
        severity: "warn",
      });
    }
  }
  return out;
}

/**
 * Correlate 7-day Radio Management events with this client's presence and drops.
 *
 * Highest priority: RRM/DFS radar on the AP the client was connected to at that
 * instant — DFS disassociates 5 GHz clients immediately (Juniper/Mist RRM docs).
 */
export function radioEventCorrelations(
  radioEvents, events, sessions = null, stats = null, apRadio = null, store = null,
) {
  if ((!radioEvents || radioEvents.length === 0) && store === null) return [];
  let st = store;
  if (st === null) {
    const seeds = expandClientAps(sessions, events, stats, null);
    st = new RadioEventStore(seeds);
    st.addMany(radioEvents);
  }
  const drops = clientDrops(events || []);
  const out = [];
  let radarKept = 0;
  const seenRadar = new Set();
  for (const [sess, re] of st.hitsForSessions(sessions)) {
    if (!isRadarEvent(re)) continue;
    const sig = JSON.stringify([re.ap ?? null, re.timestamp ?? null, re.event ?? null]);
    if (seenRadar.has(sig)) continue;
    seenRadar.add(sig);
    if (radarKept >= MAX_RADAR_CORRELATIONS) continue;
    const ts = Number(epochS(re.timestamp) || 0);
    const onAp = hexMac(sess.ap);
    const hits = [];
    for (const d of drops) {
      const dt = Number(epochS(d.timestamp) || 0) - ts;
      if (dt < -15 || dt > WINDOW_RADIO_DFS_S) continue;
      if (st.related(d.ap, re.ap) || sameApMac(d.ap, re.ap)) hits.push([dt, d]);
    }
    hits.sort((a, b) => Math.abs(a[0]) - Math.abs(b[0]));
    const drop = hits.length ? hits[0][1] : null;
    const dt = hits.length ? hits[0][0] : null;
    const apn = formatMac(re.ap || "");
    const uid = `${pyFloatStr(re.timestamp)}-${hexMac(re.ap) || "ap"}`;
    const clientName = apNameFor(onAp, radioEvents, apRadio);
    const radarName = re.apName || apn;
    const fact = radarFact(re, onAp, clientName, null, drop);
    let evidence;
    if (drop !== null) {
      evidence =
        `${re.label} at radar AP ${radarName} (${apn}), channel ${fact.radarChannel}. ` +
        `Client was on ${clientName} (${formatMac(onAp)}) — same AP. ` +
        `${drop.type} ${Math.trunc(dt)}s later. DFS vacates 5 GHz immediately.`;
    } else {
      evidence =
        `${re.label} at radar AP ${radarName} (${apn}), channel ${fact.radarChannel}. ` +
        `Client was connected to ${clientName} (${formatMac(onAp)}) — same AP as the radar event. ` +
        "No matching deauth in the client log, but DFS still forces a channel change.";
    }
    out.push({
      id: `radio-radar-${uid}`,
      title: `${re.label} on the AP this client was connected to`,
      evidence,
      confidence: "high",
      severity: "crit",
      highlight: true,
      detail: fact,
    });
    radarKept += 1;
  }

  const clientAps = st.clientAps.size ? st.clientAps : expandClientAps(sessions, events, stats, null);
  for (const re of radioEvents || []) {
    const ts = Number(epochS(re.timestamp) || 0);
    const reAp = hexMac(re.ap);
    // Radar rows were all handled through the store above; the Python's later
    // `if radar:` branch is unreachable for the same reason.
    if (isRadarEvent(re)) continue;
    if (
      reAp && clientAps.size && !clientAps.has(reAp) &&
      ![...clientAps].some((c) => st.related(reAp, c))
    ) {
      continue;
    }
    const [connected] = radarHitsThisClient(re, sessions || [], events || [], stats);
    const hits = [];
    for (const d of drops) {
      const dt = Number(epochS(d.timestamp) || 0) - ts;
      if (dt < -15 || dt > WINDOW_RADIO_RRM_S) continue;
      // Drop must be on the same AP as the radio event. Same channel on a
      // different AP is coincidence, not causation.
      if (connected || sameApMac(d.ap, re.ap)) hits.push([dt, d]);
    }
    hits.sort((a, b) => Math.abs(a[0]) - Math.abs(b[0]));
    const drop = hits.length ? hits[0][1] : null;
    const dt = hits.length ? hits[0][0] : null;
    let chBit = "";
    if (re.channelChanged) {
      chBit = ` Channel ${Math.trunc(re.preChannel || 0)} → ${Math.trunc(re.channel || 0)}.`;
    }
    let pwrBit = "";
    if (powerChanged(re)) pwrBit = ` Power ${re.prePower} → ${re.power} dBm.`;
    const apn = formatMac(re.ap || "");
    const uid = `${pyFloatStr(re.timestamp)}-${reAp || "ap"}`;

    if (!(DISRUPTIVE_RADIO.has(re.event) || re.channelChanged || powerChanged(re))) continue;
    if (!(connected || drop !== null)) continue;

    if (re.event === "neighbor-ap-down" && connected) {
      out.push({
        id: `radio-neighbor-${uid}`,
        title: "Neighbor AP went down while this client was on it",
        evidence:
          `Neighbor-AP-down on ${apn} while the client session was there.` +
          (drop !== null ? ` ${drop.type} ${Math.trunc(dt)}s later.` : "") +
          " Remaining APs absorb the cell — expect a burst of roams and weaker RSSI.",
        confidence: "high",
        severity: "crit",
      });
      continue;
    }

    if (re.channelChanged && connected) {
      out.push({
        id: `radio-channel-${uid}`,
        title: `AP channel change while client was associated (${re.label})`,
        evidence:
          `${re.label} on AP ${apn}.${chBit}` +
          (drop !== null
            ? ` ${drop.type} ${Math.trunc(dt)}s later.`
            : " Client was on this radio at the change.") +
          " A mid-session channel change is a forced roam.",
        confidence: "high",
        severity: "warn",
      });
      continue;
    }

    if (powerChanged(re) && connected && !re.channelChanged) {
      out.push({
        id: `radio-power-${uid}`,
        title: "RRM power change on the AP this client was on",
        evidence:
          `${re.label} on AP ${apn}.${pwrBit} ` +
          "A sudden drop in TX power shrinks the cell and looks like a coverage hole to a mid-cell client.",
        confidence: "medium",
        severity: "warn",
      });
      continue;
    }

    if (drop !== null) {
      out.push({
        id: `radio-${re.event}-${uid}`,
        title: `Client drop after ${String(re.label || "radio event").toLowerCase()}`,
        evidence: `${re.label} on AP ${apn} then ${drop.type} ${Math.trunc(dt)}s later.${chBit}${pwrBit}`,
        confidence: "medium",
        severity: "warn",
      });
    }
  }
  return out;
}

/** Teams/Zoom quality vs wireless drops, roams, RF, and RRM radar. */
export function callCorrelations(
  calls, events, sessions = null, stats = null, radioEvents = null, apRadio = null, store = null,
) {
  if (!calls || calls.length === 0) return [];
  const drops = (events || []).filter((e) =>
    ["DEAUTH", "DISASSOC", "DISCONNECT"].some((k) => String(e.type || "").toUpperCase().includes(k)),
  );
  const roams = (events || []).filter((e) => String(e.type || "").toUpperCase().includes("ROAM"));
  const dhcpFail = (events || []).filter(
    (e) => String(e.type || "").toUpperCase().includes("DHCP") && e.negative,
  );
  const handshake = drops.filter(
    (e) => String(e.reason) === "15" || `${e.type} ${e.text}`.toLowerCase().includes("4-way"),
  );
  const rssi = (stats || {}).rssi;
  const snr = (stats || {}).snr;
  const retries = (stats || {}).txRetries;
  const rb = rssiBand(rssi ?? null);
  const sb = snrBand(snr ?? null);
  const out = [];
  const radars = (radioEvents || []).filter((re) => isRadarEvent(re));

  for (const c of calls) {
    const label = c.appLabel || "Call";
    const overlapping = drops.filter((d) => callOpenAt(c, Number(d.timestamp || 0)));
    const roamHits = roams.filter((d) => callOpenAt(c, Number(d.timestamp || 0)));
    const dhcpHits = dhcpFail.filter((d) => callOpenAt(c, Number(d.timestamp || 0)));
    const hsHits = handshake.filter((d) => callOpenAt(c, Number(d.timestamp || 0)));
    const radarHits = [];
    const seenR = new Set();

    const takeCallRadar = (re) => {
      if (!callOpenAt(c, Number(epochS(re.timestamp) || 0))) return;
      const sig = JSON.stringify([re.ap ?? null, re.timestamp ?? null, re.event ?? null]);
      if (seenR.has(sig)) return;
      seenR.add(sig);
      radarHits.push(re);
    };

    if (store !== null) {
      for (const [, re] of store.hitsForSessions(sessions)) takeCallRadar(re);
    }
    if (!radarHits.length) {
      for (const re of radars) {
        const [same] = radarHitsThisClient(re, sessions || [], events || [], stats);
        if (same) takeCallRadar(re);
      }
    }
    radarHits.sort((a, b) => (epochS(a.timestamp) || 0) - (epochS(b.timestamp) || 0));
    const start = Number(epochS(c.start) || 0);

    if (radarHits.length) {
      for (const re of radarHits) {
        const rts = Number(epochS(re.timestamp) || 0);
        const onAp = clientApAt(sessions || [], events || [], stats, rts);
        const clientName = apNameFor(onAp, radioEvents, apRadio);
        const radarName = re.apName || formatMac(re.ap || "");
        const fact = radarFact(re, onAp, clientName, c, overlapping.length ? overlapping[0] : null);
        const meet = c.meetingId ? ` meeting ${c.meetingId}` : "";
        out.push({
          id: `call-radar-${pyFloatStr(c.start)}-${pyFloatStr(re.timestamp)}-${hexMac(re.ap)}`,
          title: `${label} in progress during ${re.label}`,
          evidence:
            `${label}${meet} ${Math.trunc(c.duration || 0)}s ` +
            `(audio ${dash(c.audioQuality)} / ` +
            `video ${dash(c.videoQuality)}). ` +
            `Client AP at radar time: ${clientName} (${onAp ? formatMac(onAp) : "—"}). ` +
            `${re.label} on ${radarName} (${formatMac(re.ap || "")}), ` +
            `channel ${fact.radarChannel}, ${fact.radarWidth}, ${fact.radarPower}.`,
          confidence: "high",
          severity: "crit",
          highlight: true,
          detail: fact,
        });
      }
      continue;
    }

    if (overlapping.length) {
      const d = overlapping[0];
      const endedAtDrop = Boolean(
        c.end && Math.abs(Number(c.end) - Number(d.timestamp || 0)) <= 20,
      );
      const title = endedAtDrop
        ? `${label} dropped with the wireless disconnect`
        : `${label} overlapped a wireless disconnect`;
      let extra = "";
      if (hsHits.length) extra = " 4-way handshake timeout during the call — media path died with the keys.";
      else if (dhcpHits.length) extra = " DHCP failed during the call — L3, not Teams.";
      out.push({
        id: `call-drop-${pyFloatStr(c.start)}`,
        title,
        evidence:
          `${label} ${Math.trunc(c.duration || 0)}s, audio ${dash(c.audioQuality)}, ` +
          `video ${dash(c.videoQuality)}. ` +
          `${d.type} at ${pyFloatStr(d.timestamp)}.${extra} ` +
          "The call failure is the wireless event, not a Teams outage.",
        confidence: "high",
        severity: c.poor || endedAtDrop ? "crit" : "warn",
      });
      continue;
    }

    if (roamHits.length && (c.poor || roamHits.length >= 2)) {
      out.push({
        id: `call-roam-${pyFloatStr(c.start)}`,
        title: `${label} during AP roam / ping-pong`,
        evidence:
          `${roamHits.length} roam(s) while ${label} was up. ` +
          "Each roam is a brief media blackout; two or more in a meeting is choppy audio even if RSSI recovers.",
        confidence: c.poor ? "high" : "medium",
        severity: "warn",
      });
      continue;
    }

    if (c.poor && retries !== null && retries !== undefined && retries >= 80) {
      out.push({
        id: `call-retries-${pyFloatStr(c.start)}`,
        title: `Poor ${label} quality with high TX retries`,
        evidence:
          `${label} audio ${c.audioQuality} / video ${c.videoQuality} with ${retries} TX retries. ` +
          "Airtime contention or interference, not a Teams cloud issue.",
        confidence: "high",
        severity: ["crit", "warn"].includes(rb) ? "crit" : "warn",
      });
      continue;
    }

    if (c.poor) {
      const audioOnly = qualityPoor(c.audioQuality) && !qualityPoor(c.videoQuality);
      if (["crit", "warn"].includes(rb) || ["crit", "warn"].includes(sb)) {
        out.push({
          id: `call-rf-${pyFloatStr(c.start)}`,
          title: `Poor ${label} quality with weak RF`,
          evidence:
            `${label} audio ${c.audioQuality} / video ${c.videoQuality} ` +
            `while RSSI ${rssi} dBm and SNR ${snr} dB. Real-time media is the first thing coverage holes break.`,
          confidence: "high",
          severity: "crit",
        });
      } else if (audioOnly && rb === "good") {
        out.push({
          id: `call-qos-${pyFloatStr(c.start)}`,
          title: `Poor ${label} audio while Wi-Fi RF and video look fine`,
          evidence:
            `Audio ${c.audioQuality} but video ${c.videoQuality} at RSSI ${rssi} dBm. ` +
            "Classic missing DSCP/WMM or WAN jitter — not an AP coverage hole.",
          confidence: "medium",
          severity: "warn",
        });
      } else {
        out.push({
          id: `call-qos-${pyFloatStr(c.start)}`,
          title: `Poor ${label} quality while Wi-Fi RF looks fine`,
          evidence:
            `${label} audio ${c.audioQuality} / video ${c.videoQuality} ` +
            `with RSSI ${rssi} dBm. Not a coverage hole — check WAN/NAT, DSCP/WMM, or the Teams client path.`,
          confidence: "medium",
          severity: "warn",
        });
      }
      continue;
    }

    // Short failed join: call started within 45s of an association and lasted <20s
    if (c.duration !== null && c.duration !== undefined && Number(c.duration) > 0 && Number(c.duration) < 20) {
      const assoc = (events || []).filter(
        (e) =>
          String(e.type || "").toUpperCase().includes("ASSOCIAT") &&
          Math.abs(Number(e.timestamp || 0) - start) <= 45,
      );
      if (assoc.length) {
        out.push({
          id: `call-join-${pyFloatStr(c.start)}`,
          title: `${label} died right after Wi-Fi join`,
          evidence:
            `${label} lasted ${Math.trunc(c.duration)}s starting next to ${assoc[0].type}. ` +
            "Client associated, then the meeting never got a stable media path.",
          confidence: "medium",
          severity: "warn",
        });
      }
    }
  }

  const poorTeams = calls.filter((c) => c.teams && c.poor);
  if (poorTeams.length >= 2 && !out.some((x) => String(x.id || "").startsWith("call-"))) {
    out.push({
      id: "call-repeat-poor",
      title: "Repeated poor Microsoft Teams calls in 7 days",
      evidence:
        `${poorTeams.length} poor Teams sessions for this MAC over 7 days. ` +
        "Pattern is the client or its path, not a one-off meeting.",
      confidence: "medium",
      severity: "warn",
    });
  }
  return out;
}

export function buildCorrelations(stats, events, sessions) {
  const out = [];
  const chrono = events.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const rssi = (stats || {}).rssi;
  const snr = (stats || {}).snr;
  const rb = rssiBand(rssi ?? null);
  const sb = snrBand(snr ?? null);
  const deauth = events.filter(
    (e) => e.type.toUpperCase().includes("DEAUTH") || e.type.toUpperCase().includes("DISASSOC"),
  );
  const dhcpFail = events.filter((e) => e.type.toUpperCase().includes("DHCP") && e.negative);
  const dnsFail = events.filter((e) => e.type.toUpperCase().includes("DNS") && e.negative);
  const roam = events.filter((e) => e.type.toUpperCase().includes("ROAM"));
  const handshake = deauth.filter(
    (e) =>
      String(e.reason) === "15" ||
      `${e.type} ${e.text}`.toLowerCase().includes("4-way") ||
      `${e.type} ${e.text}`.toLowerCase().includes("handshake"),
  );
  const idle = deauth.filter(
    (e) => String(e.reason) === "4" || `${e.type} ${e.text}`.toLowerCase().includes("inactiv"),
  );
  const left = deauth.filter((e) => ["3", "8"].includes(String(e.reason)));

  if (rb === "crit" && sb === "crit") {
    out.push({
      id: "rf-coverage",
      title: "Coverage hole (weak RSSI and SNR together)",
      evidence: `Live RSSI ${rssi} dBm and SNR ${snr} dB. Mist treats RSSI < −75 dBm as a bad-roam / coverage signature; SNR < 15 dB confirms the client is at the edge or obstructed.`,
      confidence: "high",
      severity: "crit",
    });
  } else if (!["crit", "unknown"].includes(rb) && sb === "crit") {
    out.push({
      id: "rf-noise",
      title: "Interference / noise (SNR collapsed while RSSI is still usable)",
      evidence: `RSSI ${rssi} dBm is not critical, but SNR ${snr} dB is. That pattern is noise, CCI, or a dirty channel — not a simple distance problem.`,
      confidence: "high",
      severity: "crit",
    });
  }

  for (const d of dhcpFail) {
    const prior = chrono.filter(
      (e) =>
        e.timestamp < d.timestamp &&
        d.timestamp - e.timestamp <= WINDOW_DHCP_S &&
        ["ASSOCIATION", "ROAMED", "AUTHORIZATION", "DEAUTH", "DISASSOC"].some((k) =>
          e.type.toUpperCase().includes(k),
        ),
    );
    if (prior.length) {
      const last = prior[prior.length - 1];
      out.push({
        id: `dhcp-after-join-${pyFloatStr(d.timestamp)}`,
        title: "DHCP failed after join / roam — L3, not RF",
        evidence: `${last.type} at the prior AP, then ${d.type} ${pyRound(d.timestamp - last.timestamp)}s later. Association succeeded; DORA did not. Check VLAN, helper, and gateway on AP ${d.ap || last.ap || "—"}.`,
        confidence: "high",
        severity: "crit",
      });
      break;
    }
  }

  if (handshake.length) {
    const h = handshake[0];
    out.push({
      id: `handshake-${pyFloatStr(h.timestamp)}`,
      title: "4-way handshake timeout (PSK / 802.1X)",
      evidence: `${describeReason(h.reason || 15)} on AP ${h.ap || "—"}. Classic mismatch of PSK, expired 802.1X, or a client that associated then failed key exchange.`,
      confidence: "high",
      severity: "crit",
    });
  }

  if (idle.length && ["crit", "warn"].includes(rb)) {
    out.push({
      id: "sticky-idle",
      title: "Sticky client then inactivity deauth",
      evidence: `${idle.length} inactivity (reason 4) deauth(s) while RF is ${rssi} dBm. Client held a far AP until the AP aged it out — typical sticky-client / coverage-hole sequence in Mist roaming docs.`,
      confidence: "high",
      severity: "crit",
    });
  } else if (idle.length) {
    out.push({
      id: "idle-timeout",
      title: "Idle timeout deauth (reason 4)",
      evidence: `${idle.length} inactivity disconnect(s). Device slept, power-saved, or stopped transmitting; not necessarily an RF outage.`,
      confidence: "medium",
      severity: "warn",
    });
  }

  const apSeq = chrono.filter((e) => e.ap).map((e) => e.ap);
  let flips = 0;
  for (let i = 1; i < apSeq.length; i += 1) if (apSeq[i] !== apSeq[i - 1]) flips += 1;
  const aps = uniqueAps(chrono);
  if (flips >= PINGPONG_MIN && aps.length === 2) {
    out.push({
      id: "ping-pong",
      title: "AP ping-pong between two radios",
      evidence: `${flips} AP transitions oscillating across ${aps.join(" ↔ ")}. Overlapping cells, sticky 2.4/5, or a coverage saddle — not a single bad AP.`,
      confidence: "high",
      severity: "warn",
    });
  } else if (roam.length >= 4 || aps.length >= 3) {
    out.push({
      id: "excessive-roam",
      title: "Excessive roaming / AP hopping",
      evidence: `${roam.length} roam event(s) across ${aps.length} AP(s). Mist flags this as sticky-client or coverage-hole behavior when RSSI on the serving AP is poor.`,
      confidence: "medium",
      severity: "warn",
    });
  }

  for (let i = 1; i < chrono.length; i += 1) {
    const prev = chrono[i - 1];
    const cur = chrono[i];
    if (
      ["5", "6"].includes(bandGroup(prev.band)) &&
      bandGroup(cur.band) === "24" &&
      (cur.type.toUpperCase().includes("ROAM") || cur.type.toUpperCase().includes("ASSOCIATION"))
    ) {
      out.push({
        id: "band-drop",
        title: "Warning roam: dropped from 5/6 GHz to 2.4 GHz",
        evidence: `Band ${prev.band} → ${cur.band} during ${cur.type}. Mist marks inter-band jumps as warning roams; expect lower rates and more airtime contention.`,
        confidence: "high",
        severity: "warn",
      });
      break;
    }
  }

  const retries = (stats || {}).txRetries;
  const hasRetries = retries !== null && retries !== undefined;
  if (hasRetries && retries >= 80 && ["good", "warn"].includes(rb)) {
    out.push({
      id: "retries-rf-ok",
      title: "High TX retries with usable RSSI (interference / multipath)",
      evidence: `${retries} TX retries while RSSI is ${rssi} dBm. Signal is present but frames are failing — CCI, non-Wi-Fi interference, or a hidden node, not a coverage hole.`,
      confidence: "medium",
      severity: "warn",
    });
  } else if (hasRetries && retries >= 80 && rb === "crit") {
    out.push({
      id: "retries-edge",
      title: "High TX retries at the cell edge",
      evidence: `${retries} TX retries with RSSI ${rssi} dBm. Client is both weak and retrying — add coverage or reduce sticky behavior toward a nearer AP.`,
      confidence: "high",
      severity: "crit",
    });
  }

  const rate = (stats || {}).txRate;
  if (rate !== null && rate !== undefined && rate > 0 && rate < 24 && rb === "good") {
    out.push({
      id: "rate-mismatch",
      title: "PHY rate too low for the measured RSSI",
      evidence: `TX rate ${rate} Mbps with RSSI ${rssi} dBm. Capability, band, or retry backoff is capping throughput even though the RF looks fine.`,
      confidence: "medium",
      severity: "warn",
    });
  }

  const short = sessions.filter((s) => s.duration && s.duration > 0 && s.duration < 60);
  if (short.length >= 2) {
    const shortAps = uniqueAps(short);
    const apBit =
      shortAps.length === 1
        ? ` — concentrated on AP ${shortAps[0]}`
        : ` across ${shortAps.length} AP(s)`;
    out.push({
      id: "short-sessions",
      title: "Unstable association (sessions under 60s)",
      evidence: `${short.length} session(s) lasted under a minute${apBit}. Pair with the deauth reason on that radio.`,
      confidence: shortAps.length === 1 ? "high" : "medium",
      severity: "warn",
    });
  }

  const times = deauth.map((e) => e.timestamp).sort((a, b) => a - b);
  let cluster = 1;
  let maxCluster = 1;
  for (let i = 1; i < times.length; i += 1) {
    if (times[i] - times[i - 1] <= WINDOW_CLUSTER_S) {
      cluster += 1;
      maxCluster = Math.max(maxCluster, cluster);
    } else {
      cluster = 1;
    }
  }
  if (maxCluster >= 3) {
    out.push({
      id: "deauth-cluster",
      title: "Burst of disconnects (not an isolated drop)",
      evidence: `${maxCluster} deauth/disassoc events within ${Math.floor(WINDOW_CLUSTER_S / 60)} minutes. Burst pattern points to a repeating cause (PSK, DHCP, or a flapping radio) rather than a one-off roam.`,
      confidence: "high",
      severity: "crit",
    });
  }

  if (dnsFail.length && !dhcpFail.length) {
    out.push({
      id: "dns-only",
      title: "DNS failed after a successful L2/L3 join",
      evidence: `${dnsFail.length} DNS failure(s) with no DHCP failure in the window. Wireless and DHCP are likely fine; inspect DNS reachability from that VLAN.`,
      confidence: "medium",
      severity: "warn",
    });
  }

  if (left.length && !idle.length && rb === "good") {
    out.push({
      id: "client-left",
      title: "Client left the BSS (often user-initiated)",
      evidence: `${left.length} leave-BSS reason(s) (3/8) while RF is healthy. Sleep, interface bounce, or the user walking away — not an infrastructure fault.`,
      confidence: "medium",
      severity: "info",
    });
  }

  const rank = { crit: 0, warn: 1, info: 2 };
  const conf = { high: 0, medium: 1, low: 2 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity] || conf[a.confidence] - conf[b.confidence]);
  return dedupeCorrelations(out);
}
