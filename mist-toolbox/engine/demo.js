// Ported from mist_disconnect_console.py lines 3073-3272.
// The offline sample investigation. Kept as a function rather than a frozen
// demo.json so its timestamps stay relative to now — the same reason the Python
// builds it per request.

import { pickCall } from "./calls.js";
import { pickEvent } from "./normalize.js";
import { annotateRadioEvents, radarSessionAlerts } from "./radar.js";
import { RadioEventStore, pickRrmEvent } from "./rrm.js";
import { DEFAULT_HOST, DEMO_MAC, hexMac, mistDeviceId } from "./util.js";
import { buildVerdict } from "./verdict.js";

export function demoResult(jitter = false) {
  const t = Math.trunc(Date.now() / 1000);
  const j = jitter ? Math.trunc((Math.random() - 0.5) * 6) : 0;
  const stats = {
    mac: DEMO_MAC,
    hostname: "DEMO-MBP",
    manufacture: "Apple",
    os: "macOS 15.5",
    model: "MacBookPro18,3",
    ssid: "CORP-WIFI",
    vlan: 40,
    ip: "10.40.12.88",
    ap: "0a0027aa1102",
    band: "5",
    channel: 149,
    proto: "ax",
    rssi: -81 + j,
    snr: Math.max(6, 11 + Math.floor(j / 2)),
    txRate: 58,
    rxRate: 48,
    uptime: 140,
    lastSeen: t - 12,
    txBytes: 1843200,
    rxBytes: 9216000,
    username: "demo.user",
    keyMgmt: "WPA2-PSK",
    txRetries: 214,
    rxRetries: 88,
    dualBand: true,
  };
  const events = [
    pickEvent({ timestamp: t - 40, type: "CLIENT_DNS_OK", text: "Status code 0 Successful", ap: "0a0027aa1102", ssid: "CORP-WIFI", band: "5", channel: 149 }),
    pickEvent({ timestamp: t - 90, type: "CLIENT_DHCP_TIMED_OUT", text: "DORA incomplete — no ACK", ap: "0a0027aa1102", ssid: "CORP-WIFI", band: "5", channel: 149 }),
    pickEvent({ timestamp: t - 140, type: "CLIENT_ASSOCIATION", text: "Associated", ap: "0a0027aa1102", ssid: "CORP-WIFI", band: "5", channel: 149 }),
    pickEvent({ timestamp: t - 148, type: "CLIENT_DEAUTHENTICATION", text: "Deauthenticated by AP", ap: "0a0027aa1103", ssid: "CORP-WIFI", band: "5", channel: 36, reason: 4 }),
    pickEvent({ timestamp: t - 420, type: "CLIENT_DEAUTHENTICATION", text: "4-way handshake timeout", ap: "0a0027aa1103", ssid: "CORP-WIFI", band: "5", channel: 36, reason: 15 }),
    pickEvent({ timestamp: t - 900, type: "CLIENT_ROAMED", text: "Roamed from 0a0027aa1103", ap: "0a0027aa1102", ssid: "CORP-WIFI", band: "5", channel: 149 }),
    pickEvent({ timestamp: t - 1800, type: "CLIENT_AUTHORIZATION", text: "Authorized", ap: "0a0027aa1103", ssid: "CORP-WIFI", band: "5", channel: 36 }),
    pickEvent({ timestamp: t - 3600, type: "CLIENT_DISASSOCIATION", text: "STA leaving BSS", ap: "0a0027aa1103", ssid: "CORP-WIFI", band: "2.4", channel: 11, reason: 8 }),
  ];
  const sessions = [
    { ap: "0a0027aa1102", apName: "DEMO-AP-F2-aa:11:02", ssid: "CORP-WIFI", band: "5", connect: t - 140, disconnect: null, duration: 140 },
    { ap: "0a0027aa1103", apName: "DEMO-AP-F2-aa:11:03", ssid: "CORP-WIFI", band: "5", connect: t - 480, disconnect: t - 148, duration: 332 },
    { ap: "0a0027aa1103", apName: "DEMO-AP-F2-aa:11:03", ssid: "CORP-WIFI", band: "5", connect: t - 900, disconnect: t - 840, duration: 44 },
    { ap: "0a0027aa1102", apName: "DEMO-AP-F2-aa:11:02", ssid: "CORP-WIFI", band: "5", connect: t - 7200, disconnect: t - 3600, duration: 3580 },
  ];
  const marvis = {
    results: [
      {
        category: "Device Health",
        text: " The AP is currently online. Client DEMO-MBP was connected to DEMO-AP-F2-aa:11:02 most of the time.",
        site_id: "demo-site",
      },
      {
        category: "Wireless connectivity",
        text: "Weak RSSI and handshake timeouts on AP 0a0027aa1103. Client repeatedly deauthenticates then reassociates.",
      },
    ],
    start: t - 86400,
    end: t,
  };
  const nwJ = Math.max(0, Math.min(20, j * 2));
  const channels = [
    { channel: 100, site: 40, external: 0, nonWifi: 0, serving: false },
    { channel: 104, site: 15, external: 0, nonWifi: 0, serving: false },
    { channel: 108, site: 47, external: 0, nonWifi: 0, serving: false },
    { channel: 112, site: 19, external: 0, nonWifi: 0, serving: false },
    { channel: 116, site: 34, external: 0, nonWifi: 0, serving: false },
    { channel: 132, site: 28, external: 0, nonWifi: 0, serving: false },
    { channel: 136, site: 17, external: 0, nonWifi: 0, serving: false },
    { channel: 140, site: 24, external: 0, nonWifi: 2, serving: false },
    { channel: 144, site: 9, external: 0, nonWifi: 0, serving: true },
    { channel: 149, site: 29, external: 0, nonWifi: 0, serving: false },
    { channel: 153, site: 16, external: 0, nonWifi: 70 + nwJ, serving: false },
    { channel: 157, site: 20, external: 0, nonWifi: 0, serving: false },
    { channel: 161, site: 0, external: 5, nonWifi: 75, serving: false },
    { channel: 165, site: 0, external: 0, nonWifi: 100, serving: false },
  ];
  const apRadio = {
    apMac: "0a0027aa1102",
    apName: "DEMO-AP-F2-aa:11:02",
    deviceId: mistDeviceId("0a0027aa1102"),
    status: "connected",
    band: "5",
    source: "marvis",
    dwellSeconds: 3794,
    dwellShare: 0.98,
    marvisMentioned: true,
    marvisName: "DEMO-AP-F2-aa:11:02",
    selectionNote:
      "Marvis named DEMO-AP-F2-aa:11:02 as the AP this client used most of the time. Chart is that radio (0a:00:27:aa:11:02).",
    fallback: false,
    scope: "ap",
    unavailable: null,
    lastSeen: t - 8,
    radio: {
      channel: 144,
      bandwidth: 20,
      power: 8,
      numClients: 0,
      utilAll: 12,
      utilTx: 1,
      utilRxInBss: 9,
      utilRxOtherBss: 0,
      utilNonWifi: 0,
      utilUnknownWifi: 0,
      utilUndecodable: 0,
    },
    channels,
  };
  let radioEvents = [
    pickRrmEvent({
      timestamp: t - 156, ap: "0a0027aa1103", band: "5",
      event: "rrm-radar", channel: 149, pre_channel: 36,
      bandwidth: 80, pre_bandwidth: 80, power: 17, pre_power: 17,
      usage: "5", pre_usage: "5", apName: "DEMO-AP-F2-aa:11:03",
    }),
    pickRrmEvent({
      timestamp: t - 80, ap: "0a0027aa1102", band: "5",
      event: "triggered-site_rrm", channel: 144, pre_channel: 144,
      bandwidth: 20, pre_bandwidth: 20, power: 8, pre_power: 14,
      usage: "5", pre_usage: "5", apName: "DEMO-AP-F2-aa:11:02",
    }),
    pickRrmEvent({
      timestamp: t - 90000, ap: "0a0027aa1102", band: "5",
      event: "interference-ap-non-wifi", channel: 144, pre_channel: 153,
      bandwidth: 20, pre_bandwidth: 80, power: 8, pre_power: 14,
      usage: "5", pre_usage: "5", apName: "DEMO-AP-F2-aa:11:02",
    }),
    pickRrmEvent({
      timestamp: t - 2 * 86400 - 3600, ap: "0a0027aa1102", band: "5",
      event: "scheduled-site_rrm", channel: 144, pre_channel: 144,
      bandwidth: 20, pre_bandwidth: 20, power: 8, pre_power: 8,
      usage: "5", pre_usage: "5", apName: "DEMO-AP-F2-aa:11:02",
    }),
    pickRrmEvent({
      timestamp: t - 4 * 86400, ap: "0a0027aa1105", band: "5",
      event: "neighbor-ap-down", channel: 108, pre_channel: 108,
      bandwidth: 40, pre_bandwidth: 40, power: 8, pre_power: 8,
      usage: "5", pre_usage: "5", apName: "DEMO-AP-F2-aa:11:05",
    }),
  ];
  radioEvents = annotateRadioEvents(radioEvents, events, sessions, stats);
  const calls = [
    pickCall({
      app: "teams", mac: DEMO_MAC, meeting_id: "demo-teams-1",
      start_time: t - 210, end_time: t - 35,
      audio_quality: 2, video_quality: 3, rating: 2,
    }),
    pickCall({
      app: "teams", mac: DEMO_MAC, meeting_id: "demo-teams-2",
      start_time: t - 86400 - 3600, end_time: t - 86400 - 1800,
      audio_quality: 5, video_quality: 5, rating: 5,
    }),
    pickCall({
      app: "zoom", mac: DEMO_MAC, meeting_id: "demo-zoom-1",
      start_time: t - 3 * 3600, end_time: t - 3 * 3600 + 2400,
      audio_quality: 4, video_quality: 4,
    }),
  ];
  const demoStore = new RadioEventStore(new Set(sessions.map((s) => hexMac(s.ap))));
  demoStore.addMany(radioEvents);
  const radarAlerts = radarSessionAlerts(radioEvents, sessions, calls, apRadio, demoStore);
  const clientRadar = demoStore.clientRadarEvents(sessions);
  return {
    demo: true,
    host: DEFAULT_HOST,
    orgId: "demo-org",
    siteId: "demo-site",
    siteName: "Sample HQ — Floor 2",
    mac: DEMO_MAC,
    duration: "1d",
    online: true,
    stats,
    sightings: [stats],
    events,
    sessions,
    marvisText: JSON.stringify(marvis, null, 2),
    marvisUnavailable: false,
    apRadio,
    radioEvents,
    radioEventsUnavailable: null,
    clientRadarEvents: clientRadar,
    calls,
    callsUnavailable: null,
    radarAlerts,
    radioStoreStats: {
      scanned: demoStore.scanned,
      dropped: demoStore.dropped,
      radars: demoStore.radars.length,
      kept: demoStore.kept.length,
      clientHits: clientRadar.length,
    },
    verdict: buildVerdict(stats, events, sessions, apRadio, radioEvents, calls, demoStore),
    fetchedAt: Math.trunc(Date.now()),
    email: "demo@local",
    orgs: [{ id: "demo-org", name: "Interconnected Systems (sample)" }],
    sites: [{ id: "demo-site", name: "Sample HQ — Floor 2" }],
  };
}
