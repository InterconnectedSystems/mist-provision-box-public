// Ported from mist_disconnect_console.py lines 1357-1765.
// "Was this client's session on the AP that took radar?" — the DFS banner and
// the session/event helpers every correlation path shares.

import { callOpenAt } from "./calls.js";
import { epochS, formatMac, hexMac, num, pyFloatStr } from "./util.js";

export function sameApMac(a, b) {
  const ha = hexMac(a);
  const hb = hexMac(b);
  return Boolean(ha && hb && ha === hb);
}

export function isRadarEvent(ev) {
  const e = String(ev.event || "").toLowerCase();
  return e === "radar-detected" || e === "rrm-radar" || e.includes("radar");
}

/** Identity of one DFS/Post radar row. Timestamps collapse to whole seconds. */
export function radarEventSig(re) {
  if (!re) return ["", 0, "", null];
  return [
    hexMac(re.ap),
    Math.trunc(epochS(re.timestamp) || 0),
    String(re.event || ""),
    re.channel === undefined ? null : re.channel,
  ];
}

export function powerChanged(ev) {
  const pre = num(ev.prePower);
  const cur = num(ev.power);
  if (pre === null || cur === null) return false;
  return Math.abs(Number(cur) - Number(pre)) >= 3;
}

export function bandHzLabel(b) {
  const s = String(b ?? "").trim().toLowerCase();
  if (s === "24" || s === "2.4" || s === "2") return "2.4 GHz";
  if (s === "6") return "6 GHz";
  if (!s) return "—";
  return "5 GHz";
}

export function arrowVals(pre, cur, unit = "") {
  const isBlank = (v) => v === null || v === undefined || v === "" || v === 0 || v === false;
  const str = (v) => (v === null || v === undefined ? "None" : String(v));
  if (isBlank(pre) || str(pre) === str(cur)) {
    return !(cur === null || cur === undefined || cur === "") ? `${cur}${unit}` : "—";
  }
  if (cur === null || cur === undefined || cur === "") return `${pre}${unit}`;
  return `${pre}${unit} → ${cur}${unit}`;
}

export function apNameFor(mac, radioEvents = null, apRadio = null) {
  const h = hexMac(mac);
  if (!h) return "—";
  if (apRadio && sameApMac(apRadio.apMac, h) && apRadio.apName) return String(apRadio.apName);
  for (const re of radioEvents || []) {
    if (sameApMac(re.ap, h) && re.apName) return String(re.apName);
  }
  return formatMac(h);
}

/** Structured fields so the dashboard can name the call, AP, time, and radar row. */
export function radarFact(re, clientAp, clientName, call = null, drop = null) {
  const c = call || {};
  const d = drop || {};
  return {
    call: call ? c.appLabel ?? null : null,
    meetingId: c.meetingId || null,
    callStart: call ? c.start ?? null : null,
    callEnd: call ? c.end ?? null : null,
    callDuration: call ? c.duration ?? null : null,
    audioQuality: call ? c.audioQuality ?? null : null,
    videoQuality: call ? c.videoQuality ?? null : null,
    clientAp: hexMac(clientAp) || null,
    clientApName: clientName || null,
    radarEvent: re.label || re.event,
    radarType: re.event,
    radarTime: re.timestamp,
    radarAp: hexMac(re.ap) || null,
    radarApName: re.apName || null,
    radarChannel: arrowVals(re.preChannel, re.channel),
    radarWidth: arrowVals(re.preBandwidth, re.bandwidth, " MHz"),
    radarPower: arrowVals(re.prePower, re.power, " dBm"),
    radarBand: `${bandHzLabel(re.preUsage || re.band)} → ${bandHzLabel(re.usage || re.band)}`,
    dropType: drop ? d.type ?? null : null,
    dropTime: drop ? d.timestamp ?? null : null,
  };
}

/**
 * AP this client was associated to at epoch t.
 *
 * Sessions first, then the last client event at or before t. Live stats AP is
 * only used if t is within 5 minutes of now — otherwise a 4-day-old radar would
 * be pinned to whichever AP the client is on today, which is a false match.
 */
export function clientApAt(sessions, events, stats, t) {
  const tt = Number(epochS(t) || 0);
  const covering = [];
  for (const s of sessions || []) {
    const start = epochS(s.connect);
    if (start === null || Number(start) === 0) continue;
    if (sessionCovers(s, tt) && s.ap) covering.push([Number(start), hexMac(s.ap)]);
  }
  if (covering.length) {
    covering.sort((a, b) => b[0] - a[0]);
    return covering[0][1];
  }
  const prior = (events || []).filter((e) => (epochS(e.timestamp) || 0) <= tt + 2 && e.ap);
  if (prior.length) {
    prior.sort((a, b) => (epochS(a.timestamp) || 0) - (epochS(b.timestamp) || 0));
    return hexMac(prior[prior.length - 1].ap);
  }
  const live = hexMac((stats || {}).ap);
  if (live && Math.abs(Date.now() / 1000 - tt) <= 300) return live;
  return "";
}

export function sessionCovers(sess, t) {
  const tt = Number(epochS(t) || 0);
  const start = epochS(sess.connect);
  if (start === null || Number(start) === 0) return false;
  let end = epochS(sess.disconnect);
  // Mist often sends disconnect=0 for an open session. Treat 0 / inverted as open.
  if (end === null || Number(end) === 0 || Number(end) < Number(start)) end = tt + 1;
  return Number(start) - 2 <= tt && tt <= Number(end) + 2;
}

/** Client session on this AP covering epoch t. Same-AP is required. */
export function sessionOnApAt(sessions, t, ap) {
  const hits = (sessions || []).filter(
    (s) => sessionCovers(s, t) && (sameApMac(s.ap, ap) || sameApMac(s.bssid, ap)),
  );
  if (!hits.length) return null;
  hits.sort((a, b) => Number(b.connect || 0) - Number(a.connect || 0));
  return hits[0];
}

function alertSessionWindow(a) {
  const start = Number(epochS(a.sessionConnect) || 0);
  let end = epochS(a.sessionDisconnect);
  if (end === null || Number(end) === 0 || Number(end) < start) end = start + 10 ** 12;
  return [start, Number(end)];
}

function dedupeAlertRadios(radios) {
  const seen = new Set();
  const out = [];
  for (const r of radios || []) {
    if (!r) continue;
    const sig = JSON.stringify(radarEventSig(r));
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(r);
  }
  return out;
}

/** One banner per AP association. Near-duplicate session rows collapse. */
function foldOverlappingRadarAlerts(alerts, store) {
  if (alerts.length <= 1) return alerts;

  const apKey = (a) => {
    const h = hexMac(a.sessionAp);
    return store ? store.key(h) : h;
  };

  const out = [];
  for (const a of alerts) {
    const [as_, ae] = alertSessionWindow(a);
    let placed = false;
    for (const host of out) {
      let related = apKey(host) === apKey(a);
      if (!related && store) related = store.related(host.sessionAp, a.sessionAp);
      if (!related) continue;
      const [hs, he] = alertSessionWindow(host);
      if (as_ - 2 > he || hs - 2 > ae) continue;
      if (!Object.prototype.hasOwnProperty.call(host, "radios")) {
        host.radios = host.radio ? [host.radio] : [];
      }
      host.radios.push(...(a.radios || (a.radio ? [a.radio] : [])));
      if (!host.call && a.call) {
        host.call = a.call;
        host.meetingId = a.meetingId;
        host.callStart = a.callStart;
        host.callEnd = a.callEnd;
      }
      if ((a.sessionDuration || 0) > (host.sessionDuration || 0)) {
        for (const k of [
          "session", "sessionConnect", "sessionDisconnect", "sessionDuration",
          "sessionAp", "sessionApName", "summary", "title",
        ]) {
          if (a[k] !== null && a[k] !== undefined) host[k] = a[k];
        }
      }
      placed = true;
      break;
    }
    if (!placed) out.push(a);
  }
  return out;
}

/**
 * Dashboard alerts: a client SESSION was associated to the AP that took radar.
 *
 * Juniper Mist: on DFS radar the AP deauthenticates all associated clients.
 * A radar on any other AP is not this client's problem — no alert.
 * Events-only guesses do not count; this alert requires a session record.
 *
 * Many DFS hits on the same association (7-day lookback on a busy 5 GHz cell)
 * are grouped under that session so the banner does not explode.
 */
export function radarSessionAlerts(radioEvents, sessions, calls = null, apRadio = null, store = null) {
  const raw = [];
  let pairs = [];
  if (store) {
    pairs = store.hitsForSessions(sessions);
  } else {
    for (const re of radioEvents || []) {
      if (!isRadarEvent(re)) continue;
      const ts = Number(epochS(re.timestamp) || 0);
      const sess = sessionOnApAt(sessions, ts, re.ap);
      if (sess) pairs.push([sess, re]);
    }
  }
  const seenPair = new Set();
  const uniquePairs = [];
  for (const [sess, re] of pairs) {
    const sig = JSON.stringify(radarEventSig(re));
    if (seenPair.has(sig)) continue;
    seenPair.add(sig);
    uniquePairs.push([sess, re]);
  }
  pairs = uniquePairs;

  for (const [sess, re] of pairs) {
    const ts = Number(epochS(re.timestamp) || 0);
    const apMac = hexMac(sess.ap);
    const apName = sess.apName || apNameFor(apMac, radioEvents, apRadio);
    let overlappingCall = null;
    for (const c of calls || []) {
      if (callOpenAt(c, ts)) {
        overlappingCall = c;
        break;
      }
    }
    const fact = radarFact(re, apMac, apName, overlappingCall);
    let meet = "";
    if (overlappingCall) {
      meet =
        ` ${overlappingCall.appLabel || "Call"}` +
        (overlappingCall.meetingId ? ` meeting ${overlappingCall.meetingId}` : "") +
        " was in progress.";
    }
    const radio = {
      timestamp: re.timestamp,
      ap: hexMac(re.ap),
      apName: re.apName || apName,
      band: re.band,
      channel: re.channel,
      preChannel: re.preChannel,
      bandwidth: re.bandwidth,
      preBandwidth: re.preBandwidth,
      power: re.power,
      prePower: re.prePower,
      event: re.event,
      label: re.label,
      usage: re.usage,
      preUsage: re.preUsage,
      channelChanged: re.channelChanged,
      highlight: true,
      onClientAp: true,
    };
    raw.push({
      id: `session-radar-${pyFloatStr(re.timestamp)}-${apMac}`,
      severity: "crit",
      title: `Session was on this AP during ${re.label || "Post radar"}`,
      summary:
        `This client's session on ${apName} (${formatMac(apMac)}) was active when ` +
        `${re.label || "Post radar"} hit that same AP ` +
        `(channel ${fact.radarChannel}).${meet} ` +
        "DFS vacates 5 GHz and deauthenticates every associated station.",
      sessionAp: apMac,
      sessionApName: apName,
      sessionConnect: sess.connect ?? null,
      sessionDisconnect: sess.disconnect ?? null,
      sessionDuration: sess.duration ?? null,
      radarEvent: re.label || re.event,
      radarTime: re.timestamp,
      radarAp: hexMac(re.ap),
      radarApName: re.apName || apName,
      radarChannel: fact.radarChannel,
      radarWidth: fact.radarWidth,
      radarPower: fact.radarPower,
      radarBand: fact.radarBand,
      call: overlappingCall ? overlappingCall.appLabel ?? null : null,
      meetingId: overlappingCall ? overlappingCall.meetingId ?? null : null,
      callStart: overlappingCall ? overlappingCall.start ?? null : null,
      callEnd: overlappingCall ? overlappingCall.end ?? null : null,
      detail: fact,
      session: {
        ap: apMac,
        apName,
        ssid: sess.ssid ?? null,
        band: sess.band ?? null,
        connect: sess.connect ?? null,
        disconnect: sess.disconnect ?? null,
        duration: sess.duration ?? null,
        hitByRadar: true,
      },
      radio,
      radios: [radio],
    });
  }

  const grouped = new Map();
  const order = [];

  const canonAp = (mac) => {
    const h = hexMac(mac);
    return store ? store.key(h) : h;
  };

  for (const a of raw) {
    const key = JSON.stringify([canonAp(a.sessionAp), Math.trunc(epochS(a.sessionConnect) || 0)]);
    if (!grouped.has(key)) {
      grouped.set(key, a);
      order.push(key);
      continue;
    }
    const host = grouped.get(key);
    if (!Object.prototype.hasOwnProperty.call(host, "radios")) {
      host.radios = host.radio ? [host.radio] : [];
    }
    host.radios.push(a.radio);
    if (!host.call && a.call) {
      host.call = a.call;
      host.meetingId = a.meetingId;
      host.callStart = a.callStart;
      host.callEnd = a.callEnd;
    }
  }
  const folded = foldOverlappingRadarAlerts(order.map((k) => grouped.get(k)), store);
  const out = [];
  for (const a of folded) {
    const radios = dedupeAlertRadios(a.radios || (a.radio ? [a.radio] : []));
    radios.sort((x, y) => (epochS(y.timestamp) || 0) - (epochS(x.timestamp) || 0));
    a.radios = radios;
    a.radio = radios.length ? radios[0] : a.radio;
    const n = radios.length;
    if (n > 1) {
      a.title = `Session was on this AP during ${n} radar events`;
      a.summary =
        `This client's session on ${a.sessionApName} (${formatMac(a.sessionAp || "")}) ` +
        `was associated while ${n} DFS / Post radar events hit that same AP. ` +
        "Each event is listed under this banner. DFS vacates 5 GHz and deauthenticates every associated station.";
      a.id = `session-radar-${Math.trunc(epochS(a.sessionConnect) || 0)}-${a.sessionAp}`;
    }
    out.push(a);
  }

  for (const s of sessions || []) {
    const hits = [];
    for (const a of out) {
      let related = sameApMac(s.ap, a.sessionAp) || sameApMac(s.bssid, a.sessionAp);
      if (!related && store) related = store.related(s.ap, a.sessionAp);
      if (!related) continue;
      for (const r of a.radios || (a.radio ? [a.radio] : [])) {
        if (r && sessionCovers(s, epochS(r.timestamp) || 0)) hits.push(r.timestamp);
      }
    }
    s.radarHits = hits;
    s.hitByRadar = hits.length > 0;
  }
  return out;
}

/** True only when the radar AP is the AP this client was on at that timestamp. */
export function radarHitsThisClient(re, sessions, events, stats) {
  const ts = Number(epochS(re.timestamp) || 0);
  const onAp = clientApAt(sessions || [], events || [], stats, ts);
  if (!onAp || !re.ap) return [false, onAp];
  return [sameApMac(onAp, re.ap), onAp];
}

export function clientDrops(events) {
  const out = [];
  for (const e of events) {
    const u = String(e.type || "").toUpperCase();
    if (["DEAUTH", "DISASSOC", "DISCONNECT"].some((k) => u.includes(k)) || u.includes("ROAM")) {
      out.push(e);
    }
  }
  return out;
}

export function annotateRadioEvents(radioEvents, events, sessions, stats) {
  for (const re of radioEvents) {
    const onAp = clientApAt(sessions, events, stats, Number(re.timestamp || 0));
    re.onClientAp = sameApMac(onAp, re.ap);
    re.highlight = Boolean(isRadarEvent(re) && re.onClientAp);
  }
  return radioEvents;
}
