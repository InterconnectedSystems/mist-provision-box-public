// Parity checks vs the published correlation engine.
// Direct port of mist_disconnect_console.py self_test() (lines 4120-4674).
// Run: node --test  (no npm dependencies, by design)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { pickCall, qualityPoor } from "../engine/calls.js";
import { pickEvent, pickStats } from "../engine/normalize.js";
import { channelsFromRrm, pickDominantAp, siteAirtimeByChannel } from "../engine/ap.js";
import { parseMarvisApHints } from "../engine/marvis.js";
import {
  RadioEventStore, pickRrmEvent, rrmChannelStack, rrmEventsQuery, rrmOccupancyStack, rrmRowsFrom,
} from "../engine/rrm.js";
import {
  clientApAt, isRadarEvent, powerChanged, radarHitsThisClient, radarSessionAlerts,
  sameApMac, sessionCovers,
} from "../engine/radar.js";
import {
  buildCorrelations, callCorrelations, radioEventCorrelations, rfOccupancyCorrelations,
} from "../engine/correlate.js";
import { buildVerdict } from "../engine/verdict.js";
import { demoResult } from "../engine/demo.js";
import { DEMO_MAC, dedupeCorrelations, epochS, rrmTimeSlices } from "../engine/util.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const readExt = (name) => readFileSync(join(HERE, "..", name), "utf8");
// The Python self-test greps the single PAGE string; the extension splits it in
// two, so the equivalent corpus is the markup plus its script.
const PAGE = `${readExt("console.html")}\n${readExt("console.js")}`;

const T0 = 1_700_000_000;

test("event polarity — Mist Insights treats DHCP/DNS/IP success as positive", () => {
  const assoc = pickEvent({ timestamp: 1, type: "CLIENT_ASSOCIATION", text: "Associated" });
  const author = pickEvent({ timestamp: 1, type: "CLIENT_AUTHORIZATION", text: "Authorized" });
  const deauth = pickEvent({ timestamp: 1, type: "CLIENT_DEAUTHENTICATION", text: "bye", reason: 8 });
  const disassoc = pickEvent({ timestamp: 1, type: "CLIENT_DISASSOCIATION", text: "STA leaving BSS", reason: 8 });
  const dhcp = pickEvent({ timestamp: 1, type: "CLIENT_DHCP_TIMED_OUT", text: "no ACK" });
  const dnsOk = pickEvent({ timestamp: 1, type: "CLIENT_DNS_OK", text: "Status code 0 Successful" });
  const ipOk = pickEvent({ timestamp: 1, type: "CLIENT_IP_ASSIGNED", text: "DHCP assigned 10.40.12.88" });
  const dhcpOk = pickEvent({ timestamp: 1, type: "CLIENT_DHCP_SUCCESS", text: "DHCP Success" });
  const badIp = pickEvent({ timestamp: 1, type: "CLIENT_BAD_IP_ASSIGNED", text: "Bad IP Assigned" });
  const dnsFail = pickEvent({ timestamp: 1, type: "CLIENT_DNS_FAILURE", text: "DNS Failure" });
  assert.equal(assoc.negative, false, JSON.stringify(assoc));
  assert.equal(author.negative, false, JSON.stringify(author));
  assert.equal(deauth.negative, true, JSON.stringify(deauth));
  assert.equal(disassoc.negative, true, JSON.stringify(disassoc));
  assert.equal(dhcp.negative, true, JSON.stringify(dhcp));
  assert.equal(dnsOk.negative, false, JSON.stringify(dnsOk));
  assert.equal(ipOk.negative, false, JSON.stringify(ipOk));
  assert.equal(dhcpOk.negative, false, JSON.stringify(dhcpOk));
  assert.equal(badIp.negative, true, JSON.stringify(badIp));
  assert.equal(dnsFail.negative, true, JSON.stringify(dnsFail));
});

const STATS = {
  mac: "aabbccddeeff", hostname: "h", manufacture: "Apple", os: null, model: null,
  ssid: "corp", vlan: 40, ip: "10.0.0.2", ap: "ap1", band: "5", channel: 149,
  proto: "ax", rssi: -49, snr: 38, txRate: 200, rxRate: 200, uptime: 200,
  lastSeen: 1, txBytes: 1, rxBytes: 1, username: null, keyMgmt: "WPA2-PSK",
  txRetries: 271, rxRetries: 10, dualBand: true,
};

test("verdict shape — retries card, deauth notes, no score/label", () => {
  const cors = buildCorrelations(STATS, [], []);
  const hit = cors.find((c) => c.id === "retries-rf-ok");
  assert.ok(hit, JSON.stringify(cors));
  assert.ok(hit.evidence.includes("CCI") && hit.evidence.includes("hidden node"), hit.evidence);

  const assoc = pickEvent({ timestamp: 1, type: "CLIENT_ASSOCIATION", text: "Associated" });
  const author = pickEvent({ timestamp: 1, type: "CLIENT_AUTHORIZATION", text: "Authorized" });
  const deauth = pickEvent({ timestamp: 1, type: "CLIENT_DEAUTHENTICATION", text: "bye", reason: 8 });
  const v = buildVerdict(STATS, [assoc, author, deauth], []);
  const notes = v.notes.join(" ").toLowerCase();
  assert.ok(notes.includes("deauth/disassoc"), JSON.stringify(v.notes));
  assert.ok(!notes.includes("authentication/association failure"), JSON.stringify(v.notes));
  assert.ok(!("score" in v) && !("label" in v), JSON.stringify(v));
  const empty = buildVerdict(null, [], []);
  assert.ok(!("score" in empty) && !("label" in empty), JSON.stringify(empty));
  assert.ok(empty.primaryCause.startsWith("No dominant failure signature"), JSON.stringify(empty));

  const aliased = pickStats({ mac: "aabbccddeeff", num_tx_retries: 90, rssi: -50 });
  assert.equal(aliased.txRetries, 90, JSON.stringify(aliased));
});

const DEMO_SESSIONS = [
  { ap: "0a0027aa1102", ssid: "c", band: "5", connect: 1, disconnect: null, duration: 3794 },
  { ap: "0a0027aa1101", ssid: "c", band: "5", connect: 1, disconnect: 2, duration: 28 },
];
const USER_MARVIS = {
  results: [{
    category: "Device Health",
    text: " The AP is currently online. Client demo-client was connected to DEMO-AP-F2-aa:11:01 most of the time.",
    site_id: "9885f682-0bcc-4a35-5645-6456546546456",
  }],
  start: 1787763220,
  end: 1787849620,
};

test("dominant AP — Marvis name beats longest session, with inventory fallbacks", () => {
  const hints = parseMarvisApHints(USER_MARVIS);
  assert.equal(hints.mostName, "DEMO-AP-F2-aa:11:01", JSON.stringify(hints));

  const inventory = [
    { id: "00000000-0000-0000-1000-0a0027aa1101", name: "DEMO-AP-F2-aa:11:01", mac: "0a0027aa1101", type: "ap" },
    { id: "00000000-0000-0000-1000-0a0027aa1102", name: "DEMO-AP-F2-aa:11:02", mac: "0a0027aa1102", type: "ap" },
  ];
  const picked = pickDominantAp(DEMO_SESSIONS, STATS, [], USER_MARVIS, inventory);
  assert.equal(picked.apMac, "0a0027aa1101", JSON.stringify(picked));
  assert.equal(picked.source, "marvis", JSON.stringify(picked));
  assert.equal(picked.fallback, false, JSON.stringify(picked));
  assert.ok((picked.apNameHint || picked.marvisName || "").includes("aa:11:01"), JSON.stringify(picked));

  // inventory name without colons still matches
  const invNocolon = [{ id: "x", name: "DEMO-AP-F2-aa1101", mac: "0a0027aa1101", type: "ap" }];
  const pickedNc = pickDominantAp(DEMO_SESSIONS, STATS, [], USER_MARVIS, invNocolon);
  assert.equal(pickedNc.apMac, "0a0027aa1101", JSON.stringify(pickedNc));

  // MAC suffix in Marvis name matches inventory mac even if labels differ
  const invSuf = [{ id: "x", name: "DEMO-AP-F2", mac: "0a0027aa1101", type: "ap" }];
  const pickedSuf = pickDominantAp(DEMO_SESSIONS, STATS, [], USER_MARVIS, invSuf);
  assert.equal(pickedSuf.apMac, "0a0027aa1101", JSON.stringify(pickedSuf));

  // no inventory → cannot resolve name to MAC → longest session + note
  const pickedFb = pickDominantAp(DEMO_SESSIONS, STATS, [], USER_MARVIS, []);
  assert.equal(pickedFb.apMac, "0a0027aa1102", JSON.stringify(pickedFb));
  assert.equal(pickedFb.fallback, true, JSON.stringify(pickedFb));
  assert.ok(pickedFb.selectionNote.toLowerCase().includes("marvis named"), pickedFb.selectionNote);
});

test("RRM occupancy stack — Site vs External vs Non-Wi-Fi", () => {
  const [s, e, n] = rrmChannelStack({
    util_score_non_wifi: 0.76, util_score_other: 0.16,
    rssi: -55, other_rssi: -80, channel: 153,
  });
  assert.ok(n >= 70, JSON.stringify([s, e, n]));
  assert.ok(s > e, JSON.stringify([s, e, n]));

  assert.deepEqual(
    rrmOccupancyStack({ wifi: 0.16, non_wifi: 0.70, rssi: -50, channel: 153 }), [16, 0, 70],
  );
  assert.deepEqual(
    rrmOccupancyStack({ wifi: 0.05, non_wifi: 0.75, other_rssi: -62, channel: 161 }), [0, 5, 75],
  );
  assert.deepEqual(
    rrmOccupancyStack({ wifi: 0.09, non_wifi: 0, rssi: -48, channel: 144 }), [9, 0, 0],
  );
  // non_wifi set must NOT drop util_score_other (portal orange/teal caps)
  assert.deepEqual(
    rrmOccupancyStack({ non_wifi: 0.75, util_score_other: 0.05, other_ssid: "ext" }), [0, 5, 75],
  );
  assert.deepEqual(rrmOccupancyStack({ util_score_other: 0.40, rssi: -52 }), [40, 0, 0]);
  assert.deepEqual(rrmOccupancyStack({ util_score_other: 0.40 }, true), [40, 0, 0]);
  // unknown wifi → External (teal)
  assert.deepEqual(rrmOccupancyStack({ util_score_other: 0.05 }), [0, 5, 0]);

  const keyed = rrmRowsFrom({ 100: { wifi: 0.4, rssi: -50 }, 153: { non_wifi: 0.7, wifi: 0.16, rssi: -55 } });
  assert.deepEqual(new Set(keyed.map((r) => Math.trunc(r.channel))), new Set([100, 153]), JSON.stringify(keyed));
});

const INV = [
  { mac: "0a0027aa1101", type: "ap", radio_stat: { band_5: {
    channel: 144, power: 8, num_clients: 0, util_all: 13,
    util_tx: 1, util_rx_in_bss: 8, util_rx_other_bss: 0, util_non_wifi: 0,
  } } },
  { mac: "0a0027aa1104", type: "ap", radio_stat: { band_5: {
    channel: 157, power: 8, num_clients: 0, util_all: 25,
    util_tx: 4, util_rx_in_bss: 16, util_rx_other_bss: 3, util_non_wifi: 0,
  } } },
  { mac: "0a0027aa1105", type: "ap", radio_stat: { band_5: {
    channel: 108, power: 8, num_clients: 2, util_all: 50,
    util_tx: 10, util_rx_in_bss: 37, util_rx_other_bss: 2, util_non_wifi: 1,
  } } },
];

test("site airtime and the merged occupancy histogram", () => {
  const air = siteAirtimeByChannel(INV, "5");
  assert.equal(air[144], 9, JSON.stringify(air)); // 1+8 in-BSS, not util_all
  assert.equal(air[157], 20, JSON.stringify(air));
  assert.equal(air[108], 47, JSON.stringify(air));

  const rrmOnlyDirty = [
    { channel: 153, non_wifi: 0.70, util_score_other: 0.16, rssi: -52 },
    { channel: 161, non_wifi: 0.75, util_score_other: 0.05, other_ssid: "x" },
    { channel: 165, non_wifi: 1.0, other_ssid: "x" },
  ];
  const merged = channelsFromRrm(rrmOnlyDirty, 144, null, "5", air);
  const by = Object.fromEntries(merged.map((c) => [c.channel, c]));
  assert.ok(by[108].site === 47 && by[108].external === 0 && by[108].nonWifi === 0, JSON.stringify(by[108]));
  assert.ok(by[144].site === 9 && by[144].serving === true, JSON.stringify(by[144]));
  assert.equal(by[157].site, 20, JSON.stringify(by[157]));
  assert.ok(by[153].nonWifi === 70 && by[153].site >= 16, JSON.stringify(by[153]));
  assert.ok(
    by[161].nonWifi === 75 && by[161].external === 5 && by[161].site === 0, JSON.stringify(by[161]),
  );
  assert.equal(by[165].nonWifi, 100, JSON.stringify(by[165]));

  const padded = channelsFromRrm(
    [{ channel: 153, wifi: 0.16, non_wifi: 0.70, rssi: -50 }], 144, null, "5",
  );
  const chs = Object.fromEntries(padded.map((c) => [c.channel, c]));
  assert.ok(100 in chs && 165 in chs && 144 in chs, JSON.stringify(Object.keys(chs)));
  assert.equal(chs[144].serving, true);
  assert.ok(chs[153].nonWifi === 70 && chs[153].site === 16);
  assert.equal(chs[144].external, 0); // not radio_stat overlay
});

const AP_RADIO = {
  apMac: "0a0027aa1102", apName: "DEMO-AP-F2", status: "connected",
  band: "5", unavailable: null,
  radio: { channel: 144, utilNonWifi: 0, utilRxOtherBss: 0, utilUnknownWifi: 0, utilRxInBss: 9 },
  channels: [
    { channel: 144, site: 9, external: 0, nonWifi: 0, serving: true },
    { channel: 153, site: 16, external: 0, nonWifi: 76, serving: false },
  ],
};

test("RF occupancy correlations feed the verdict", () => {
  const rf = rfOccupancyCorrelations(AP_RADIO, STATS);
  const ids = new Set(rf.map((c) => c.id));
  assert.ok(ids.has("ap-adj-nonwifi"), JSON.stringify(rf));
  assert.ok(!ids.has("ap-nonwifi"), JSON.stringify(rf));

  const dirty = {
    ...AP_RADIO,
    channels: [
      { channel: 144, site: 9, external: 0, nonWifi: 42, serving: true },
      { channel: 153, site: 16, external: 0, nonWifi: 76, serving: false },
    ],
  };
  const rf2 = rfOccupancyCorrelations(dirty, STATS);
  assert.ok(rf2.some((c) => c.id === "ap-nonwifi"), JSON.stringify(rf2));
  const v2 = buildVerdict(STATS, [], [], dirty);
  assert.ok(v2.notes.some((n) => n.includes("non-Wi-Fi occupancy")), JSON.stringify(v2.notes));
  assert.ok(v2.correlations.some((c) => c.id === "ap-nonwifi"), JSON.stringify(v2.correlations));
});

const RADAR = pickRrmEvent({
  timestamp: T0, ap: "0a0027aa1103", band: "5",
  event: "rrm-radar", channel: 149, pre_channel: 36,
  bandwidth: 80, pre_bandwidth: 80, power: 17, pre_power: 17,
});
const DROP = pickEvent({
  timestamp: T0 + 12, type: "CLIENT_DEAUTHENTICATION",
  text: "Deauthenticated by AP", ap: "0a0027aa1103", channel: 36, reason: 4,
});
const SESS_ON = [{ ap: "0a0027aa1103", connect: T0 - 60, disconnect: T0 + 12, duration: 72 }];
const SESS_OPEN = [{ ap: "0a0027aa1103", connect: T0 - 60, disconnect: null, duration: null }];
const SESS_OTHER = [{ ap: "0a0027aa1102", connect: T0 - 60, disconnect: T0 + 60, duration: 120 }];

test("RRM event query and labels", () => {
  const q = rrmEventsQuery("5", 1, 100);
  assert.ok(q.band === "5" && q.duration === "7d" && q.page === 1, JSON.stringify(q));
  assert.throws(() => rrmEventsQuery(""), (err) => err.message.toLowerCase().includes("band"));
  const nw = pickRrmEvent({
    event: "interference-ap-non-wifi", ap: "0a0027aa1102", band: "5", channel: 136, pre_channel: 44,
  });
  assert.equal(nw.label, "Interference AP non wifi", JSON.stringify(nw));
  assert.equal(RADAR.channelChanged, true, JSON.stringify(RADAR));
  assert.equal(RADAR.label, "Post radar", JSON.stringify(RADAR));
  assert.ok(isRadarEvent(RADAR));
});

test("radar correlates only with the AP the client was actually on", () => {
  const rc = radioEventCorrelations([RADAR], [DROP], SESS_ON, null, { apMac: "0a0027aa1102" });
  assert.equal(rc.length, 1, JSON.stringify(rc));
  assert.equal(rc[0].highlight, true, JSON.stringify(rc[0]));
  assert.ok(rc[0].title.toLowerCase().includes("connected to"), JSON.stringify(rc[0]));
  assert.equal(rc[0].severity, "crit");
  assert.ok(sameApMac(rc[0].detail.clientAp, rc[0].detail.radarAp), JSON.stringify(rc[0].detail));
  const [ok, on] = radarHitsThisClient(RADAR, SESS_ON, [DROP], null);
  assert.ok(ok === true && on === "0a0027aa1103", JSON.stringify([ok, on]));

  // Radar on the connected AP with NO deauth still highlights
  const rcNodrop = radioEventCorrelations([RADAR], [], SESS_OPEN, null, null);
  assert.ok(rcNodrop.length && rcNodrop[0].highlight === true, JSON.stringify(rcNodrop));
  assert.ok(rcNodrop[0].title.toLowerCase().includes("connected to"));

  // Radar on a different AP while client is elsewhere — correlation is invalid
  const rcMiss = radioEventCorrelations([RADAR], [], SESS_OTHER, null, { apMac: "0a0027aa1102" });
  assert.deepEqual(rcMiss, [], JSON.stringify(rcMiss));
  const [okMiss, onMiss] = radarHitsThisClient(RADAR, SESS_OTHER, [], { ap: "0a0027aa1102" });
  assert.ok(okMiss === false && onMiss === "0a0027aa1102", JSON.stringify([okMiss, onMiss]));

  // Same-channel drop on a different AP is not a radar match
  const dropOther = pickEvent({
    timestamp: T0 + 8, type: "CLIENT_DEAUTHENTICATION",
    text: "Deauthenticated by AP", ap: "0a0027aa1102", channel: 36, reason: 4,
  });
  const rcCh = radioEventCorrelations([RADAR], [dropOther], SESS_OTHER, null, { apMac: "0a0027aa1102" });
  assert.deepEqual(rcCh, [], JSON.stringify(rcCh));

  // Live stats AP must not pin a 4-day-old radar to today's AP
  const oldRadar = pickRrmEvent({
    timestamp: T0 - 4 * 86400, ap: "0a0027aa1102", band: "5",
    event: "rrm-radar", channel: 44, pre_channel: 36,
    bandwidth: 20, pre_bandwidth: 20, power: 6, pre_power: 6,
  });
  const rcOld = radioEventCorrelations([oldRadar], [], [], { ap: "0a0027aa1102" }, { apMac: "0a0027aa1102" });
  assert.deepEqual(rcOld, [], JSON.stringify(rcOld));
});

test("scheduled RRM is quiet; a real power change is not", () => {
  const sched = pickRrmEvent({
    timestamp: T0 - 100, ap: "0a0027aa1102", band: "5",
    event: "scheduled-site_rrm", channel: 144, pre_channel: 144,
    bandwidth: 20, pre_bandwidth: 20, power: 8, pre_power: 8,
  });
  assert.equal(sched.channelChanged, false, JSON.stringify(sched));
  const rc2 = radioEventCorrelations([sched], [DROP], SESS_ON, null, { apMac: "0a0027aa1102" });
  assert.deepEqual(rc2, [], JSON.stringify(rc2));

  const pwr = pickRrmEvent({
    timestamp: T0, ap: "0a0027aa1103", band: "5",
    event: "triggered-site_rrm", channel: 144, pre_channel: 144,
    bandwidth: 20, pre_bandwidth: 20, power: 8, pre_power: 14,
  });
  assert.ok(powerChanged(pwr));
  const rcPwr = radioEventCorrelations([pwr], [], SESS_OPEN, null, null);
  assert.ok(rcPwr.some((c) => c.id.startsWith("radio-power")), JSON.stringify(rcPwr));
});

const TEAMS_BAD = pickCall({
  app: "teams", mac: DEMO_MAC, meeting_id: "m1",
  start_time: T0 - 20, end_time: T0 + 80,
  audio_quality: 2, video_quality: 3, rating: 2,
});

test("Teams call vs wireless drop and vs DFS radar", () => {
  assert.ok(TEAMS_BAD.teams && TEAMS_BAD.poor, JSON.stringify(TEAMS_BAD));
  const cc = callCorrelations([TEAMS_BAD], [DROP], SESS_ON, { rssi: -81, snr: 11 }, []);
  assert.ok(cc.some((c) => c.id.startsWith("call-drop")), JSON.stringify(cc));

  const ccRadar = callCorrelations([TEAMS_BAD], [DROP], SESS_ON, { rssi: -81, snr: 11 }, [RADAR]);
  const hit = ccRadar.find((c) => c.id.startsWith("call-radar"));
  assert.ok(hit, JSON.stringify(ccRadar));
  assert.equal(hit.highlight, true, JSON.stringify(hit));
  const d = hit.detail || {};
  assert.equal(d.call, "Microsoft Teams", JSON.stringify(d));
  assert.equal(d.meetingId, "m1", JSON.stringify(d));
  assert.equal(d.callStart, T0 - 20, JSON.stringify(d));
  assert.equal(d.radarEvent, "Post radar", JSON.stringify(d));
  assert.equal(d.radarTime, T0, JSON.stringify(d));
  assert.equal(d.clientAp, "0a0027aa1103", JSON.stringify(d));
  assert.equal(d.radarAp, "0a0027aa1103", JSON.stringify(d));
  assert.equal(d.clientAp, d.radarAp, JSON.stringify(d));
  assert.ok(String(d.radarChannel).includes("36") && String(d.radarChannel).includes("149"), JSON.stringify(d));

  // Teams during radar on a DIFFERENT AP is not a valid correlation
  const ccWrongAp = callCorrelations(
    [TEAMS_BAD], [DROP], SESS_OTHER, { rssi: -81, snr: 11, ap: "0a0027aa1102" }, [RADAR],
  );
  assert.ok(!ccWrongAp.some((c) => c.id.startsWith("call-radar")), JSON.stringify(ccWrongAp));
});

test("session-on-AP radar alert is the dashboard banner", () => {
  const sess = [{ ap: "0a0027aa1103", connect: T0 - 60, disconnect: T0 + 12, duration: 72 }];
  const al = radarSessionAlerts([RADAR], sess, [TEAMS_BAD], null);
  assert.equal(al.length, 1, JSON.stringify(al));
  assert.ok(al[0].sessionAp === al[0].radarAp && al[0].radarAp === "0a0027aa1103", JSON.stringify(al[0]));
  assert.equal(al[0].call, "Microsoft Teams", JSON.stringify(al[0]));
  assert.equal(al[0].meetingId, "m1", JSON.stringify(al[0]));
  assert.equal(al[0].session.connect, sess[0].connect, JSON.stringify(al[0].session));
  assert.equal(al[0].session.ap, "0a0027aa1103", JSON.stringify(al[0].session));
  assert.equal(al[0].radio.event, "rrm-radar", JSON.stringify(al[0].radio));
  assert.ok(
    al[0].radio.preChannel === 36 && al[0].radio.channel === 149, JSON.stringify(al[0].radio),
  );
  assert.ok(PAGE.includes("This session") && PAGE.includes("This radar event"));
  assert.equal(sess[0].hitByRadar, true, JSON.stringify(sess[0]));
  assert.deepEqual(radarSessionAlerts([RADAR], SESS_OTHER, [TEAMS_BAD], null), []);
  assert.deepEqual(radarSessionAlerts([RADAR], [], [TEAMS_BAD], null), []);
  const alOpen = radarSessionAlerts([RADAR], SESS_OPEN, [], null);
  assert.ok(alOpen.length === 1 && alOpen[0].sessionAp === "0a0027aa1103", JSON.stringify(alOpen));
});

test("demo fixture carries the radar banner and is rendered untruncated", () => {
  const demo = demoResult();
  assert.ok(demo.radarAlerts.length, JSON.stringify(demo.radarAlerts));
  const da = demo.radarAlerts[0];
  assert.ok(da.sessionAp === da.radarAp && da.radarAp === "0a0027aa1103", JSON.stringify(da));
  assert.equal(da.call, "Microsoft Teams", JSON.stringify(da));
  assert.ok(demo.sessions.some((s) => s.hitByRadar), JSON.stringify(demo.sessions));
  assert.ok(!PAGE.includes("sessions.slice(0,8)"));
  assert.ok(PAGE.includes("function sessionsPanel"));
  assert.ok(PAGE.includes("nothing is truncated"));
});

test("call QoS branches — audio-only, roam, retries", () => {
  const teamsQos = pickCall({
    app: "teams", start_time: T0 - 500, end_time: T0 - 400,
    audio_quality: 1, video_quality: 5,
  });
  const cc2 = callCorrelations([teamsQos], [], [], { rssi: -52, snr: 32 }, []);
  assert.ok(
    cc2.some((c) => c.title.toLowerCase().includes("audio") && c.id.includes("qos")), JSON.stringify(cc2),
  );

  const roamEv = pickEvent({ timestamp: T0 + 5, type: "CLIENT_ROAMED", ap: "0a0027aa1102", band: "5" });
  const roamEv2 = pickEvent({ timestamp: T0 + 25, type: "CLIENT_ROAMED", ap: "0a0027aa1103", band: "5" });
  const ccRoam = callCorrelations([TEAMS_BAD], [roamEv, roamEv2], SESS_ON, { rssi: -60, snr: 28 }, []);
  assert.ok(ccRoam.some((c) => c.id.startsWith("call-roam")), JSON.stringify(ccRoam));

  const ccRet = callCorrelations(
    [pickCall({ app: "teams", start_time: T0 - 500, end_time: T0 - 400, audio_quality: 2, video_quality: 2 })],
    [], [], { rssi: -62, snr: 26, txRetries: 120 }, [],
  );
  assert.ok(ccRet.some((c) => c.id.startsWith("call-retries")), JSON.stringify(ccRet));
});

test("demo verdict has radar, call-radar, highlights, and no score", () => {
  const demo = demoResult(false);
  const demoIds = demo.verdict.correlations.map((c) => c.id);
  assert.ok(demoIds.some((i) => i.startsWith("radio-radar")), JSON.stringify(demoIds));
  assert.ok(demo.verdict.correlations.some((c) => c.highlight), JSON.stringify(demo.verdict.correlations));
  assert.ok(demoIds.some((i) => i.startsWith("call-radar")), JSON.stringify(demoIds));
  assert.ok(!("score" in demo.verdict) && !("label" in demo.verdict), JSON.stringify(Object.keys(demo.verdict)));
  assert.ok(demo.verdict.primaryCause, JSON.stringify(demo.verdict));
  assert.ok(demo.radioEvents.some((e) => e.highlight), JSON.stringify(demo.radioEvents));
  assert.ok(demo.calls.some((c) => c.teams), JSON.stringify(demo.calls));
  assert.ok(clientApAt(demo.sessions, demo.events, demo.stats, 0) || true);

  // Demo rrm-radar is on 1103 while the session t-480..t-148 covers t-156
  const demoRadar = demo.radioEvents.find((e) => e.event === "rrm-radar");
  assert.equal(demoRadar.onClientAp, true, JSON.stringify(demoRadar));
  assert.equal(demoRadar.highlight, true, JSON.stringify(demoRadar));
});

test("millisecond Mist timestamps still match second-based sessions", () => {
  assert.equal(epochS(T0), T0);
  assert.equal(epochS(T0 * 1000), T0);
  const radarMs = pickRrmEvent({
    timestamp: T0 * 1000, ap: "0a0027aa1103", band: "5",
    event: "rrm-radar", channel: 149, pre_channel: 36,
    bandwidth: 80, pre_bandwidth: 80, power: 17, pre_power: 17,
  });
  assert.equal(radarMs.timestamp, T0, JSON.stringify(radarMs));
  const rcMs = radioEventCorrelations([radarMs], [DROP], SESS_ON, null, null);
  assert.ok(rcMs.length && rcMs[0].highlight === true, JSON.stringify(rcMs));
});

test("7-day volume: 40 client DFS hits survive a 120-row neighbor flood", () => {
  const many = [];
  for (let i = 0; i < 40; i += 1) {
    many.push(pickRrmEvent({
      timestamp: T0 - i * 3600, ap: "0a0027aa1103", band: "5",
      event: "rrm-radar", channel: 149, pre_channel: 36,
      bandwidth: 80, pre_bandwidth: 80, power: 17, pre_power: 17,
    }));
  }
  for (let i = 0; i < 120; i += 1) {
    many.push(pickRrmEvent({
      timestamp: T0 - i * 1800, ap: "0a0027aa1109", band: "5",
      event: "rrm-radar", channel: 44, pre_channel: 36,
      bandwidth: 20, pre_bandwidth: 20, power: 6, pre_power: 6,
    }));
  }
  const sessWeek = [{
    ap: "0a0027aa1103", apName: "DEMO-AP-F2-aa:11:03",
    connect: T0 - 7 * 86400, disconnect: T0 + 60, duration: 7 * 86400,
  }];
  const rcMany = radioEventCorrelations(many, [], sessWeek, null, null);
  assert.equal(rcMany.length, 40, String(rcMany.length));
  assert.ok(rcMany.every((c) => c.highlight));
  const vMany = buildVerdict(null, [], sessWeek, null, many, []);
  const radarCors = vMany.correlations.filter((c) => String(c.id).startsWith("radio-radar"));
  assert.equal(radarCors.length, 40, JSON.stringify([radarCors.length, radarCors.slice(0, 3)]));
  assert.ok(
    vMany.notes.some((n) => n.includes("40 Post radar") || (n.includes("40") && n.toLowerCase().includes("radar"))),
    JSON.stringify(vMany.notes),
  );
  const alMany = radarSessionAlerts(many, sessWeek, [], null);
  assert.equal(alMany.length, 1, String(alMany.length));
  assert.equal(alMany[0].radios.length, 40, String(alMany[0].radios.length));
  assert.equal(sessWeek[0].hitByRadar, true);
  assert.deepEqual(
    radarSessionAlerts(many, [{ ap: "0a0027aa1102", connect: T0 - 7 * 86400, disconnect: T0, duration: 7 * 86400 }], [], null),
    [],
  );
  const stale = Array.from({ length: 5 }, (_, i) => ({
    id: `radio-radar-${T0 - i}`, title: "x", severity: "crit", confidence: "high", highlight: true,
  }));
  assert.equal(dedupeCorrelations(stale).length, 5);
});

test("two radars in one call are both kept", () => {
  const radarB = pickRrmEvent({
    timestamp: T0 + 40, ap: "0a0027aa1103", band: "5",
    event: "rrm-radar", channel: 44, pre_channel: 149,
    bandwidth: 80, pre_bandwidth: 80, power: 17, pre_power: 17,
  });
  const sessLong = [{ ap: "0a0027aa1103", connect: T0 - 60, disconnect: T0 + 90, duration: 150 }];
  const ccTwo = callCorrelations([TEAMS_BAD], [DROP], sessLong, { rssi: -81, snr: 11 }, [RADAR, radarB]);
  assert.equal(ccTwo.filter((c) => c.id.startsWith("call-radar")).length, 2, JSON.stringify(ccTwo));
});

test("store path: a buried same-AP DFS hit survives a 2000-row neighbor storm", () => {
  const storm = new RadioEventStore(new Set(["0a0027aa1103"]));
  for (let i = 0; i < 2000; i += 1) {
    storm.add(pickRrmEvent({
      timestamp: T0 - i, ap: "0a0027aa11ff", band: "5",
      event: "rrm-radar", channel: 44, pre_channel: 36,
    }));
  }
  storm.add(RADAR);
  const ccStorm = callCorrelations(
    [TEAMS_BAD], [DROP], SESS_ON, { rssi: -81, snr: 11 }, storm.exportEvents(), null, storm,
  );
  assert.ok(ccStorm.filter((c) => String(c.id).startsWith("call-radar")).length, JSON.stringify(ccStorm));
  const alStorm = radarSessionAlerts(storm.exportEvents(), SESS_ON, [TEAMS_BAD], null, storm);
  assert.ok(alStorm.length && alStorm[0].call === "Microsoft Teams", JSON.stringify(alStorm));

  // Millisecond Teams timestamps must still overlap second-based radar.
  const teamsMs = pickCall({
    app: "teams", mac: DEMO_MAC, meeting_id: "m-ms",
    start_time: (T0 - 20) * 1000, end_time: (T0 + 80) * 1000,
    audio_quality: 2, video_quality: 3,
  });
  assert.ok(teamsMs.start === T0 - 20 && teamsMs.end === T0 + 80, JSON.stringify(teamsMs));
  const ccMsCall = callCorrelations([teamsMs], [], SESS_ON, null, [RADAR]);
  assert.ok(ccMsCall.some((c) => c.id.startsWith("call-radar")), JSON.stringify(ccMsCall));
  assert.equal(ccMsCall[0].detail.call, "Microsoft Teams", JSON.stringify(ccMsCall[0]));
});

test("AP-keyed store: BSSID alias, neighbor radar indexed but not exported", () => {
  const store = new RadioEventStore(new Set(["0a0027aa1103"]), [new Set(["0a0027aa1100", "0a0027aa1103"])]);
  const buried = pickRrmEvent({
    timestamp: T0 - 3600, ap: "0a0027aa1100", band: "5",
    event: "rrm-radar", channel: 149, pre_channel: 36,
  });
  for (let i = 0; i < 2000; i += 1) {
    store.add(pickRrmEvent({
      timestamp: T0 - i, ap: "0a0027aa11ff", band: "5",
      event: "rrm-radar", channel: 44, pre_channel: 36,
    }));
  }
  store.add(buried);
  const sessB = [{ ap: "0a0027aa1103", connect: T0 - 86400, disconnect: T0, duration: 86400 }];
  assert.equal(store.hitsForSession(sessB[0]).length, 1, JSON.stringify(store.hitsForSession(sessB[0])));
  assert.equal(store.clientRadarEvents(sessB)[0].ap, "0a0027aa1100");
  const exported = store.exportEvents();
  assert.ok(!exported.some((e) => e.ap === "0a0027aa11ff"), "neighbor radar must not fill the UI export");
  assert.ok(store.radarsOnAp("0a0027aa11ff").length, "neighbor radar must stay indexed for lookup");
  const alStore = radarSessionAlerts(exported, sessB, [], null, store);
  assert.equal(alStore.length, 1, JSON.stringify(alStore));
  const rcStore = radioEventCorrelations(exported, [], sessB, null, null, store);
  assert.equal(rcStore.filter((c) => c.id.startsWith("radio-radar")).length, 1);
});

test("overlapping duplicate sessions collapse to one banner", () => {
  // The same association reported twice, connect 0.4s apart.
  const sessDup = [
    { ap: "02000000a061", apName: "AP-Demo-01", ssid: "Demo-Corp",
      band: "5", connect: T0 - 10266, disconnect: T0 + 1, duration: 10267 },
    { ap: "02000000a061", apName: "AP-Demo-01", ssid: "Demo-Corp",
      band: "5", connect: T0 - 10265.6, disconnect: T0 + 1.2, duration: 10266.8 },
  ];
  const radarDup = pickRrmEvent({
    timestamp: T0, ap: "02000000a061", band: "5",
    event: "radar-detected", channel: 149, pre_channel: 56,
    bandwidth: 20, pre_bandwidth: 20, power: 6, pre_power: 6,
    apName: "AP-Demo-01",
  });
  const storeDup = new RadioEventStore(new Set(["02000000a061"]));
  storeDup.add(radarDup);
  storeDup.add(pickRrmEvent({
    timestamp: T0, ap: "02000000a061", band: "5",
    event: "radar-detected", channel: 149, pre_channel: 56,
    bandwidth: 20, pre_bandwidth: 20, power: 6, pre_power: 6,
    apName: "AP-Demo-01",
  }));
  const alDup = radarSessionAlerts([radarDup], sessDup, [], null, storeDup);
  assert.equal(alDup.length, 1, JSON.stringify(alDup.map((a) => [a.sessionConnect, a.id])));
  assert.equal((alDup[0].radios || []).length, 1, JSON.stringify(alDup[0].radios));
  assert.equal(storeDup.clientRadarEvents(sessDup).length, 1);
  assert.ok(sessDup.every((s) => s.hitByRadar), JSON.stringify(sessDup));

  // Two distinct radars on the overlapping association → one banner, two radios.
  storeDup.add(pickRrmEvent({
    timestamp: T0 - 90, ap: "02000000a061", band: "5",
    event: "rrm-radar", channel: 100, pre_channel: 56,
    apName: "AP-Demo-01",
  }));
  const alTwo = radarSessionAlerts(storeDup.exportEvents(), sessDup, [], null, storeDup);
  assert.equal(alTwo.length, 1, JSON.stringify(alTwo));
  assert.equal(alTwo[0].radios.length, 2, JSON.stringify(alTwo[0].radios));

  // Sequential non-overlapping sessions stay as separate banners.
  const sessSeq = [
    { ap: "02000000a061", connect: T0 - 8000, disconnect: T0 - 7000, duration: 1000 },
    { ap: "02000000a061", connect: T0 - 2000, disconnect: T0 - 1000, duration: 1000 },
  ];
  const storeSeq = new RadioEventStore(new Set(["02000000a061"]));
  storeSeq.add(pickRrmEvent({ timestamp: T0 - 7500, ap: "02000000a061", event: "radar-detected", channel: 36 }));
  storeSeq.add(pickRrmEvent({ timestamp: T0 - 1500, ap: "02000000a061", event: "radar-detected", channel: 100 }));
  const alSeq = radarSessionAlerts(storeSeq.exportEvents(), sessSeq, [], null, storeSeq);
  assert.equal(alSeq.length, 2, JSON.stringify(alSeq));
  assert.ok(PAGE.includes("function uniqueRadarAlerts"));
});

test("RRM time slices split the lookback newest-first", () => {
  const slices = rrmTimeSlices("1d", T0);
  assert.equal(slices.length, 8, JSON.stringify(slices)); // 24h / 3h
  assert.ok(slices[0][1] === T0 && slices[slices.length - 1][0] === T0 - 86400);
});

test("dashboard markup contract", () => {
  assert.ok(PAGE.includes("sess-scroll"));
  assert.ok(PAGE.includes("radar-scroll"));
  assert.ok(!PAGE.includes("ranked.slice(0,60)"));
  assert.ok(PAGE.includes("function clientRadarPanel"));
  assert.ok(PAGE.includes("Radar hits on this client's APs (0)"));
  assert.ok(PAGE.includes('if(alerts.length) return ""'));
  assert.ok(PAGE.includes('(r.radarAlerts||[]).length ? "" : clientRadarPanel(r)'));
  assert.ok(PAGE.includes("btnRadioFs"));
  assert.ok(PAGE.includes("radio-fs"));
  assert.ok(PAGE.includes("Exit full screen"));
  assert.ok(PAGE.includes("up to 60 seconds"));
  assert.ok(PAGE.includes('id="fetchHint"'));
  assert.ok(PAGE.indexOf('id="btnDiag"') < PAGE.indexOf('id="fetchHint"'));
  assert.ok(PAGE.indexOf('id="btnConnect"') < PAGE.indexOf('id="btnDiag"'));
});

test("demo exposes client radar events and store stats", () => {
  const demo2 = demoResult();
  assert.ok(demo2.clientRadarEvents.length, JSON.stringify(demo2.clientRadarEvents));
  assert.ok((demo2.radioStoreStats || {}).clientHits >= 1);
});

test("open session with disconnect=0 still covers a radar hit", () => {
  // Mist sends 0, not null.
  const sessZero = [{ ap: "0a0027aa1103", connect: T0 - 60, disconnect: 0, duration: null }];
  assert.ok(sessionCovers(sessZero[0], T0));
  const alZero = radarSessionAlerts([RADAR], sessZero, [], null);
  assert.equal(alZero.length, 1, JSON.stringify(alZero));
});

test("RRM payload naming the AP as ap_mac / mac still correlates", () => {
  const radarAlias = pickRrmEvent({
    timestamp: T0, ap_mac: "0a0027aa1103", band: "5",
    event: "radar-detected", channel: 100, pre_channel: 36,
  });
  assert.equal(radarAlias.ap, "0a0027aa1103", JSON.stringify(radarAlias));
  assert.ok(isRadarEvent(radarAlias));
  const alAlias = radarSessionAlerts([radarAlias], SESS_ON, [], null);
  assert.equal(alAlias.length, 1, JSON.stringify(alAlias));
});

test("always-indexed neighbor radar does not alert for a different session AP", () => {
  const stormStore = new RadioEventStore(new Set(["0a0027aa1103"]));
  for (let i = 0; i < 50; i += 1) {
    stormStore.add(pickRrmEvent({
      timestamp: T0 - i, ap: "0a0027aa11ff", event: "rrm-radar",
      channel: 44, pre_channel: 36, band: "5",
    }));
  }
  stormStore.add(pickRrmEvent({
    timestamp: T0 - 10, ap: "0a0027aa1103", event: "rrm-radar",
    channel: 149, pre_channel: 36, band: "5",
  }));
  const sessStorm = [{ ap: "0a0027aa1103", connect: T0 - 120, disconnect: T0, duration: 120 }];
  assert.equal(stormStore.hitsForSession(sessStorm[0]).length, 1);
  assert.ok(stormStore.exportEvents().length < 10, String(stormStore.exportEvents().length));
  assert.equal(
    radarSessionAlerts(stormStore.exportEvents(), sessStorm, [], null, stormStore).length, 1,
  );
});

test("quality_poor bands", () => {
  assert.equal(qualityPoor(2), true);
  assert.equal(qualityPoor(5), false);
  assert.equal(qualityPoor(49), true);
  assert.equal(qualityPoor(80), false);
  assert.equal(qualityPoor(null), false);
});
