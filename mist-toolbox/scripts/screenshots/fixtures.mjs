// Synthetic Mist and SSR Conductor responses for the README screenshots.
//
// Everything here is made up: "Demo Org", example.com names, documentation
// and RFC 1918 addresses, locally administered MACs (02:…). No real org data
// ever reaches a screenshot, which matters because the repo is public.

export const ORG_ID = "demo-org";
export const CONDUCTOR = "https://conductor.example.net";

const SITES = [
  { id: "site-hq", name: "HQ - Toronto", networktemplate_id: "swtpl-campus", address: "100 Example Ave, Toronto ON", country_code: "CA", timezone: "America/Toronto" },
  { id: "site-ott", name: "Branch - Ottawa", networktemplate_id: "swtpl-campus", address: "20 Sample St, Ottawa ON", country_code: "CA", timezone: "America/Toronto" },
  { id: "site-mtl", name: "Warehouse - Montreal", networktemplate_id: "swtpl-branch", address: "5 Demo Rd, Montreal QC", country_code: "CA", timezone: "America/Toronto" },
];

const NOW = 1760000000; // fixed, so every regeneration matches
const mac = (n) => `020000${n.toString(16).padStart(6, "0")}`;

// ---- Switches ---------------------------------------------------------------

const SWITCHES = [
  { id: "dev-core", site: "site-hq", name: "hq-core", model: "EX4400-48P", serial: "DEMO4400A1", mac: mac(0x101), version: "23.4R2-S3", status: "connected", ip: "10.10.0.2",
    vc: [{ mac: mac(0x102), serial: "DEMO4400A2" }] },
  { id: "dev-idf1", site: "site-hq", name: "hq-idf-1", model: "EX2300-48P", serial: "DEMO2300B1", mac: mac(0x111), version: "22.4R3-S2", status: "connected", ip: "10.10.0.11" },
  { id: "dev-idf2", site: "site-hq", name: "hq-idf-2", model: "EX2300-48P", serial: "DEMO2300B2", mac: mac(0x112), version: "22.4R3-S2", status: "connected", ip: "10.10.0.12" },
  { id: "dev-ott", site: "site-ott", name: "ott-sw1", model: "EX4100-24P", serial: "DEMO4100C1", mac: mac(0x201), version: "23.4R2-S3", status: "connected", ip: "10.20.0.2" },
  { id: "dev-mtl", site: "site-mtl", name: "mtl-sw1", model: "EX2300-C-12P", serial: "DEMO2300D1", mac: mac(0x301), version: "21.4R3-S5", status: "disconnected", ip: "10.30.0.2" },
];

const IRB = {
  "dev-core": [["data", 10, "10.10.10.1/24"], ["voice", 20, "10.10.20.1/24"], ["printers", 30, "10.10.30.1/24"], ["guest", 99, "192.168.99.1/24"]],
  "dev-ott": [["data", 10, "10.20.10.1/24"], ["voice", 20, "10.20.20.1/24"]],
  // Deliberately reuses HQ's printer subnet, so the report flags a duplicate.
  "dev-mtl": [["data", 10, "10.30.10.1/24"], ["printers", 30, "10.10.30.1/24"]],
};

function configCmd(sw) {
  const lines = [
    `set system host-name ${sw.name}`,
    "set system time-zone America/Toronto",
    "set system name-server 192.0.2.53",
    "set snmp location \"" + SITES.find((s) => s.id === sw.site).name + "\"",
  ];
  for (const [name, vlan, addr] of IRB[sw.id] || []) {
    lines.push(`set vlans ${name} vlan-id ${vlan}`);
    lines.push(`set vlans ${name} l3-interface irb.${vlan}`);
    lines.push(`set interfaces irb unit ${vlan} description "${name} gateway"`);
    lines.push(`set interfaces irb unit ${vlan} family inet address ${addr}`);
  }
  for (let p = 0; p < 4; p += 1) {
    lines.push(`set interfaces ge-0/0/${p} unit 0 family ethernet-switching interface-mode access`);
    lines.push(`set interfaces ge-0/0/${p} unit 0 family ethernet-switching vlan members data`);
  }
  lines.push("set interfaces ge-0/0/47 unit 0 family ethernet-switching interface-mode trunk");
  lines.push("set protocols lldp interface all");
  lines.push("set routing-options static route 0.0.0.0/0 next-hop " + (sw.ip.replace(/\.\d+$/, ".1")));
  return lines;
}

// Power supplies per VC member (Switch PSU Status): hq-core's backup member has
// lost a supply, hq-idf-1 has an empty slot, mtl-sw1 is a single-PSU model.
const PSUS = {
  "dev-core": [["ok", "ok"], ["ok", "Failed"]],
  "dev-idf1": [["ok", "absent"]],
  "dev-idf2": [["ok", "ok"]],
  "dev-ott": [["ok", "ok"]],
  "dev-mtl": [["ok"]],
};
const psus = (id, fpc) => (PSUS[id]?.[fpc] || []).map((status, i) => ({ name: `Power Supply ${i}`, status }));

function switchStats(sw) {
  const ports = [];
  for (let p = 0; p < 8; p += 1) {
    const up = !(p === 5 || (sw.status !== "connected"));
    ports.push({
      port_id: `ge-0/0/${p}`, up, speed: up ? (p === 0 ? 10000 : 1000) : 0, full_duplex: up,
      poe_on: up && p > 0 && p < 5, power_draw: up && p > 0 && p < 5 ? (6.2 + p * 1.7).toFixed(1) : "",
      neighbor_system_name: up && p > 0 && p < 4 ? `ap-${sw.name}-${p}` : "",
      neighbor_port_desc: up && p > 0 && p < 4 ? "eth0" : "",
    });
  }
  const base = {
    id: sw.id, mac: sw.mac, name: sw.name, model: sw.model, serial: sw.serial, version: sw.version,
    status: sw.status, ip: sw.ip, site_id: sw.site, type: "switch",
    uptime: sw.status === "connected" ? 1209600 + sw.mac.length * 3600 : 0,
    last_seen: NOW - (sw.status === "connected" ? 30 : 86400),
    ports,
  };
  base.module_stat = sw.vc
    ? [
      { fpc_idx: 0, vc_role: "master", serial: sw.serial, version: sw.version, mac: sw.mac, psus: psus(sw.id, 0) },
      ...sw.vc.map((m, i) => ({ fpc_idx: i + 1, vc_role: "backup", serial: m.serial, version: sw.version, mac: m.mac, psus: psus(sw.id, i + 1) })),
    ]
    : [{ fpc_idx: 0, serial: sw.serial, version: sw.version, mac: sw.mac, psus: psus(sw.id, 0) }];
  return base;
}

function inventory() {
  const rows = [];
  for (const sw of SWITCHES) {
    rows.push({ id: sw.id, mac: sw.mac, name: sw.name, model: sw.model, serial: sw.serial, site_id: sw.site,
      connected: sw.status === "connected", type: "switch", vc_mac: sw.vc ? sw.mac : undefined });
    for (const m of sw.vc || []) {
      rows.push({ mac: m.mac, serial: m.serial, model: sw.model, site_id: sw.site, vc_mac: sw.mac,
        connected: true, type: "switch" });
    }
  }
  return rows;
}

// Access points and gateways, for tools that read the whole inventory.
const OTHER_DEVICES = [
  ...Array.from({ length: 14 }, (_, i) => ({ type: "ap", mac: mac(0x600 + i), model: "AP45", site_id: "site-hq", connected: i !== 9 })),
  ...Array.from({ length: 5 }, (_, i) => ({ type: "ap", mac: mac(0x700 + i), model: "AP34", site_id: "site-ott", connected: true })),
  ...Array.from({ length: 3 }, (_, i) => ({ type: "ap", mac: mac(0x800 + i), model: "AP24", site_id: "site-mtl", connected: i !== 2 })),
  { type: "gateway", mac: mac(0x150), model: "SRX320", site_id: "site-hq", connected: true },
  { type: "gateway", mac: mac(0x250), model: "SSR120", site_id: "site-ott", connected: true },
  { type: "ap", mac: mac(0x999), model: "AP45", connected: false },
];

const PORT_USAGES = {
  access: { mode: "access", port_network: "data", poe_disabled: false },
  ap: { mode: "trunk", port_network: "data", networks: ["data", "voice", "guest"] },
  uplink: { mode: "trunk", all_networks: true },
};

const DEVICE_CLI = {
  "dev-core": ["set protocols mstp bridge-priority 4k", "set chassis aggregated-devices ethernet device-count 8"],
  "dev-mtl": ["set poe interface ge-0/0/3 disable"],
};

function siteDevice(sw) {
  return {
    id: sw.id, mac: sw.mac, name: sw.name, model: sw.model, serial: sw.serial, site_id: sw.site, type: "switch",
    ...(DEVICE_CLI[sw.id] ? { additional_config_cmds: DEVICE_CLI[sw.id] } : {}),
    port_config: { "ge-0/0/0": { usage: "uplink" }, "ge-0/0/1-3": { usage: "ap" }, "ge-0/0/4-7": { usage: "access" } },
    port_usages: PORT_USAGES,
  };
}

// ---- Wireless ---------------------------------------------------------------

const TEMPLATES = [{ id: "tpl-corp", name: "Corporate WLANs" }];

const SWITCH_TEMPLATES = [
  { id: "swtpl-campus", name: "Campus Switching",
    additional_config_cmds: ["set system syslog host 192.0.2.10 any notice", "set system ntp server 192.0.2.123"],
    switch_matching: { enable: true, rules: [
      { name: "access-48p", match_model: "EX2300", additional_config_cmds: ["set poe management class", "set protocols lldp-med interface all"] },
    ] } },
  { id: "swtpl-branch", name: "Small Branch",
    additional_config_cmds: ["set system ntp server 192.0.2.123"] },
];
const SITE_SETTING = {
  "site-hq": { additional_config_cmds: ["set snmp location \"HQ - Toronto, 3rd floor MDF\""],
    switch_matching: { enable: true, rules: [{ name: "core", match_role: "core", additional_config_cmds: ["set protocols ospf area 0.0.0.0 interface irb.10 passive"] }] } },
  "site-ott": { additional_config_cmds: ["set snmp location \"Branch - Ottawa\"", "set system ntp server 192.0.2.123"] },
  "site-mtl": {},
};

const WLANS = {
  "site-hq": [
    { id: "w-corp", ssid: "DemoCorp", enabled: true, auth: { type: "eap", pairwise: ["wpa2-ccmp", "wpa3"] }, vlan_enabled: true, vlan_id: 10, bands: ["5", "6"], interface: "all", template_id: "tpl-corp" },
    { id: "w-guest", ssid: "DemoGuest", enabled: true, auth: { type: "open" }, vlan_enabled: true, vlan_id: 99, bands: ["24", "5"], interface: "all", template_id: "tpl-corp" },
    { id: "w-voice", ssid: "DemoVoice", enabled: true, hide_ssid: true, auth: { type: "psk", pairwise: ["wpa2-ccmp"] }, vlan_enabled: true, vlan_id: 20, bands: ["5"], interface: "all", site_id: "site-hq" },
  ],
  "site-ott": [
    { id: "w-corp", ssid: "DemoCorp", enabled: true, auth: { type: "eap", pairwise: ["wpa2-ccmp", "wpa3"] }, vlan_enabled: true, vlan_id: 10, bands: ["5", "6"], interface: "all", template_id: "tpl-corp" },
    { id: "w-guest", ssid: "DemoGuest", enabled: true, auth: { type: "open" }, vlan_enabled: true, vlan_id: 99, bands: ["24", "5"], interface: "all", template_id: "tpl-corp" },
  ],
  "site-mtl": [
    { id: "w-corp", ssid: "DemoCorp", enabled: true, auth: { type: "eap", pairwise: ["wpa2-ccmp"] }, vlan_enabled: true, vlan_id: 10, bands: ["5"], interface: "all", template_id: "tpl-corp" },
    { id: "w-scan", ssid: "DemoScanners", enabled: false, auth: { type: "psk", pairwise: ["wpa2-ccmp"] }, vlan_enabled: false, band: "24", interface: "all", site_id: "site-mtl" },
  ],
};

const NAMES = ["alex", "blair", "casey", "devon", "emery", "finley", "gray", "harper", "indigo", "jordan", "kai", "logan"];
function clients(siteId, count, subnet) {
  return Array.from({ length: count }, (_, i) => {
    const n = NAMES[(i + subnet) % NAMES.length];
    const band = i % 3 === 0 ? "24" : i % 3 === 1 ? "5" : "6";
    return {
      mac: mac(0x900000 + subnet * 0x100 + i), hostname: `${n}-laptop`, username: `${n}@example.com`,
      ip: `10.${subnet}.10.${20 + i}`, ssid: i % 5 === 4 ? "DemoGuest" : "DemoCorp", vlan_id: i % 5 === 4 ? 99 : 10,
      band, proto: band === "6" ? "ax" : band === "5" ? "ac" : "n", channel: band === "24" ? 6 : band === "5" ? 44 : 37,
      rssi: -48 - i * 3, snr: 42 - i * 2, manufacture: i % 2 ? "Apple" : "Dell", os: i % 2 ? "macOS" : "Windows 11",
      tx_rate: 866 - i * 40, rx_rate: 780 - i * 35, uptime: 3600 * (i + 1), last_seen: NOW - i * 7, site_id: siteId,
      ap_mac: mac(0x500 + subnet), key_mgmt: i % 5 === 4 ? "NONE" : "WPA2-EAP",
      ...(i % 5 === 4 ? { guest: { name: "Visitor " + (i + 1), email: `visitor${i + 1}@example.org`, company: "Example Co", authorized: true } } : {}),
    };
  });
}
const CLIENTS = { "site-hq": clients("site-hq", 9, 10), "site-ott": clients("site-ott", 5, 20), "site-mtl": clients("site-mtl", 3, 30) };

// SSID Banned / Approved Clients: the org's template SSIDs, HQ's own SSID, and a
// banned list already set at HQ (read back through the blacklist_url Mist gives).
const ORG_WLANS = [
  { id: "w-corp", ssid: "DemoCorp", template_id: "tpl-corp", block_blacklist_clients: false },
  { id: "w-guest", ssid: "DemoGuest", template_id: "tpl-corp", block_blacklist_clients: true },
];
const SITE_OWN_WLANS = { "site-hq": [{ id: "w-voice", ssid: "DemoVoice", site_id: "site-hq", block_blacklist_clients: false }] };
const HQ_BANNED = [mac(0x90ff01), mac(0x90ff02)];

// The token's role in /self. Read-only for every tool but the one that makes changes.
let selfRole = "read";
export const setSelfRole = (role) => { selfRole = role; };

// One HQ client in detail, for the Client Wi-Fi PHY Inspector. Its readings are
// chosen to show the dashboard's grades: usable signal but poor SNR on a busy,
// noisy, overlapped 80 MHz channel, with some ping-pong roaming. Times are
// relative to the run, not NOW, because the tool charts the past 24 hours.
export const PHY_MAC = mac(0x900a07);
const PHY_SITE = "site-hq";
const liveNow = () => Math.floor(Date.now() / 600000) * 600;

const AP_NAMES = ["hq-ap-01", "hq-ap-02", "hq-ap-03", "hq-ap-04", "hq-ap-05", "hq-ap-06"];
// [5 GHz primary, width, clients, util] per AP; hq-ap-03 serves the client.
const AP_5G = [[36, 80, 9, 31], [149, 80, 12, 28], [52, 80, 22, 62], [56, 20, 7, 40], [52, 40, 11, 47], [100, 80, 6, 18]];
function apStats() {
  return AP_NAMES.map((name, i) => {
    const [ch, bw, clients, util] = AP_5G[i];
    const serving = i === 2;
    return {
      id: `ap-${i}`, name, mac: mac(0x600 + i), type: "ap", model: "AP45", status: "connected", site_id: PHY_SITE,
      radio_stat: {
        band_24: { channel: [1, 6, 11][i % 3], bandwidth: 20, num_clients: 3, noise_floor: -91, util_all: 35, power: 8 },
        band_5: { mac: mac(0x6a0 + i), channel: ch, bandwidth: bw, num_clients: clients, power: serving ? 14 : 17,
          noise_floor: serving ? -88 : -94, util_all: util,
          ...(serving ? { util_tx: 12, util_rx_in_bss: 30, util_rx_other_bss: 14, util_unknown_wifi: 2, util_non_wifi: 14 } : {}) },
      },
    };
  });
}

function phyClient() {
  const base = CLIENTS[PHY_SITE].find((c) => c.mac === PHY_MAC);
  return { ...base, ap_mac: mac(0x602), band: "5", channel: 52, channel_width: 80, proto: "ax", num_streams: 2,
    rssi: -68, snr: 18, tx_rate: 480, rx_rate: 360, tx_retries: 1400, tx_pkts: 7800, rx_retries: 300, rx_pkts: 9100,
    dual_band: true, last_seen: liveNow() - 20 };
}

// A smooth, repeatable wobble for the time series.
const wave = (i, a, b) => Math.sin(i / 9) * a + Math.sin(i / 2.7) * b;
function phySeries(metric) {
  const t1 = liveNow();
  const rt = Array.from({ length: 144 }, (_, i) => t1 - (143 - i) * 600);
  const at = (f) => rt.map((_, i) => Math.round(f(i) * 10) / 10);
  const series = {
    rssi: at((i) => -63 + wave(i, 4, 2) - (i > 95 && i < 110 ? 9 : 0)),
    snr: at((i) => 24 + wave(i, 4, 2) - (i > 95 && i < 110 ? 8 : 0)),
    tx_rate: at((i) => Math.max(86, 620 + wave(i, 160, 70))),
    rx_rate: at((i) => Math.max(65, 470 + wave(i, 120, 50))),
    tx_retries: at((i) => Math.max(0, 140 + wave(i, 80, 40))),
    rx_retries: at((i) => Math.max(0, 30 + wave(i, 15, 8))),
  }[metric];
  return series ? { rt, results: series } : null;
}

function phySessions() {
  const t1 = liveNow();
  const ap = (i) => mac(0x600 + i);
  // [AP index, start hours ago, end hours ago or null]
  return [[2, 23, 17.5], [4, 17.5, 17.45], [2, 17.45, 9.2], [4, 9.2, 9.17], [2, 9.17, 9.1], [3, 9.1, 6.0], [2, 6.0, null]]
    .map(([i, a, b]) => ({ ap: ap(i), band: "5", ssid: "DemoCorp", connect: t1 - a * 3600, disconnect: b == null ? null : t1 - b * 3600,
      duration: Math.round(((b == null ? 0 : -b) + a) * 3600) }));
}

function phyEvents() {
  const t1 = liveNow();
  const ev = (h, type, text, o = {}) => ({ timestamp: t1 - h * 3600, type, text, ap: mac(0x602), band: "5", channel: 52, ...o });
  return [
    ev(22.9, "CLIENT_ASSOCIATION", "Associated"),
    ev(17.5, "CLIENT_DEAUTHENTICATION", "Deauthenticated", { reason: 4, ap: mac(0x602) }),
    ev(17.45, "CLIENT_REASSOCIATION", "Reassociated", { ap: mac(0x604) }),
    ev(9.2, "CLIENT_DISASSOCIATION", "Disassociated", { reason: 8, ap: mac(0x602) }),
    ev(9.17, "CLIENT_REASSOCIATION", "Reassociated", { ap: mac(0x604) }),
    ev(8.3, "CLIENT_DEAUTHENTICATION", "Deauthenticated", { reason: 4, ap: mac(0x602) }),
    ev(6.0, "CLIENT_REASSOCIATION", "Reassociated", { ap: mac(0x602) }),
    ev(2.1, "CLIENT_DHCP_SUCCESS", "DHCP Success"),
  ];
}

// ---- Alarms -----------------------------------------------------------------

const ALARM_DEFS = [
  { key: "switch_offline", display: "Switch offline", severity: "critical", group: "infrastructure" },
  { key: "ap_bad_cable", display: "AP bad cable", severity: "warn", group: "infrastructure" },
  { key: "dhcp_failure", display: "DHCP failure", severity: "major", group: "infrastructure" },
  { key: "rogue_ap", display: "Rogue AP detected", severity: "minor", group: "security" },
];
const ALARMS = {
  "site-hq": [
    { id: "al-1", type: "ap_bad_cable", timestamp: NOW - 3600, last_seen: NOW - 600, count: 3, aps: [mac(0x510)], hostnames: ["ap-hq-idf-1-2"], reasons: ["Cable test failed on pair 3"], status: "open", acked: false },
    { id: "al-2", type: "rogue_ap", timestamp: NOW - 7200, last_seen: NOW - 1800, count: 1, aps: [mac(0x511)], hostnames: ["ap-hq-core-1"], status: "open", acked: true, ack_admin_name: "Demo Admin" },
  ],
  "site-ott": [
    { id: "al-3", type: "dhcp_failure", timestamp: NOW - 5400, last_seen: NOW - 900, count: 12, switches: [mac(0x201)], hostnames: ["ott-sw1"], reasons: ["No DHCP offer on VLAN 20"], status: "open", acked: false },
  ],
  "site-mtl": [
    { id: "al-4", type: "switch_offline", timestamp: NOW - 86000, last_seen: NOW - 120, count: 1, switches: [mac(0x301)], hostnames: ["mtl-sw1"], status: "open", acked: false },
  ],
};

// ---- Mist router --------------------------------------------------------------

/** Answer one Mist API GET. Returns { status, body } or null for "not found". */
export function mist(path, query, host = "api.mist.com") {
  const m = (re) => path.match(re);
  let r;
  if (path === "/self") {
    return { body: { email: "demo.admin@example.com", privileges: [{ scope: "org", org_id: ORG_ID, name: "Demo Org", role: selfRole }] } };
  }
  if (path === "/const/alarm_defs") return { body: ALARM_DEFS };
  if (path === `/orgs/${ORG_ID}/sites`) return { body: SITES };
  if (path === `/orgs/${ORG_ID}/templates`) return { body: TEMPLATES };
  if (path === `/orgs/${ORG_ID}/inventory`) {
    const type = query.get("type");
    return { body: type && type !== "switch" ? [] : type === "switch" ? inventory() : [...inventory(), ...OTHER_DEVICES] };
  }
  if (path === `/orgs/${ORG_ID}/inventory/search`) {
    const rows = SWITCHES.map((sw) => ({ ...inventory().find((x) => x.mac === sw.mac),
      members: (sw.vc || []).map((m, i) => ({ mac: m.mac, serial: m.serial, member_id: i + 1 })) }));
    return { body: { results: rows, total: rows.length } };
  }
  if (path === `/orgs/${ORG_ID}/stats/devices`) return { body: SWITCHES.map(switchStats) };
  if (path === `/orgs/${ORG_ID}/stats/ports/search`) {
    const rows = SWITCHES.flatMap((sw) => switchStats(sw).ports.map((p) => ({ ...p, mac: sw.mac, site_id: sw.site })));
    return { body: { results: rows, total: rows.length } };
  }
  if ((r = m(/^\/sites\/([^/]+)\/wlans\/derived$/))) return { body: WLANS[r[1]] || [] };
  if ((r = m(/^\/sites\/([^/]+)\/stats\/clients$/))) return { body: CLIENTS[r[1]] || [] };
  if ((r = m(/^\/sites\/([^/]+)\/stats\/devices$/))) {
    if (query.get("type") === "ap") return { body: r[1] === PHY_SITE ? apStats() : [] };
    return { body: SWITCHES.filter((s) => s.site === r[1]).map(switchStats) };
  }
  if (path === `/orgs/${ORG_ID}/networktemplates`) return { body: SWITCH_TEMPLATES };
  if (path === "/sites/site-hq/setting") {
    return { body: { ...SITE_SETTING["site-hq"], blacklist_url: `https://${host}/api/v1/sites/site-hq/setting/blacklist` } };
  }
  if ((r = m(/^\/sites\/([^/]+)\/setting$/))) return { body: SITE_SETTING[r[1]] || {} };
  if (path === "/sites/site-hq/setting/blacklist") return { body: { macs: HQ_BANNED } };
  if (path === `/orgs/${ORG_ID}/setting`) return { body: {} };
  if (path === `/orgs/${ORG_ID}/wlans`) return { body: ORG_WLANS };
  if ((r = m(/^\/sites\/([^/]+)\/wlans$/))) return { body: SITE_OWN_WLANS[r[1]] || [] };
  if (path === `/orgs/${ORG_ID}/clients/search`) {
    const hit = query.get("mac") === PHY_MAC;
    return { body: { results: hit ? [{ mac: PHY_MAC, site_id: PHY_SITE, last_seen: liveNow() - 20 }] : [], total: hit ? 1 : 0 } };
  }
  if (path === `/sites/${PHY_SITE}/stats/clients/${PHY_MAC}`) return { body: phyClient() };
  if (path === `/sites/${PHY_SITE}/clients/search`) return { body: { results: [phyClient()], total: 1 } };
  if (path === `/sites/${PHY_SITE}/clients/${PHY_MAC}/events`) return { body: { results: phyEvents() } };
  if (path === `/sites/${PHY_SITE}/clients/sessions/search`) {
    const rows = phySessions();
    return { body: { results: rows, total: rows.length } };
  }
  if ((r = m(new RegExp(`^/sites/${PHY_SITE}/insights/client/${PHY_MAC}/([^/]+)$`)))) {
    const body = phySeries(decodeURIComponent(r[1]));
    return body ? { body } : null;
  }
  if ((r = m(/^\/sites\/([^/]+)\/stats\/ports\/search$/))) {
    const rows = SWITCHES.filter((s) => s.site === r[1]).flatMap((sw) => switchStats(sw).ports.map((p) => ({ ...p, mac: sw.mac })));
    return { body: { results: rows, total: rows.length } };
  }
  if ((r = m(/^\/sites\/([^/]+)\/devices$/))) return { body: SWITCHES.filter((s) => s.site === r[1]).map(siteDevice) };
  if ((r = m(/^\/sites\/([^/]+)\/devices\/([^/]+)\/config_cmd$/))) {
    const sw = SWITCHES.find((s) => s.id === r[2] || `00000000-0000-0000-1000-${s.mac}` === r[2]);
    return sw ? { body: { cli: configCmd(sw) } } : null;
  }
  if ((r = m(/^\/sites\/([^/]+)\/devices\/([^/]+)$/))) {
    const sw = SWITCHES.find((s) => s.id === r[2]);
    return sw ? { body: siteDevice(sw) } : null;
  }
  if ((r = m(/^\/sites\/([^/]+)\/alarms\/search$/))) {
    const rows = (ALARMS[r[1]] || []).map((a) => ({ ...a, site_id: r[1] }));
    return { body: { results: rows, total: rows.length, limit: Number(query.get("limit")) || 100 } };
  }
  return null;
}

// ---- SSR Conductor --------------------------------------------------------------

const ROUTERS = [["rtr-hq", ["rtr-hq-a", "rtr-hq-b"]], ["rtr-ott", ["rtr-ott-a"]]];

function bgpText(router, phase) {
  const peers = router === "rtr-hq"
    ? [["192.0.2.1", 65010, phase === "post" ? "Active" : "48", phase === "post" ? "never" : "3d04h11m"],
       ["198.51.100.1", 65020, phase === "post" ? "52" : "51", "12d02h40m"]]
    : [["203.0.113.1", 65030, "17", "6d01h05m"]];
  return [
    `BGP router identifier 10.255.0.${router === "rtr-hq" ? 1 : 2}, local AS number 65001 vrf-id 0`,
    "BGP table version 1842",
    `RIB entries ${router === "rtr-hq" ? 211 : 64}, using 39 KiB of memory`,
    `Peers ${peers.length}, using 43 KiB of memory`,
    "",
    "Neighbor        V         AS   MsgRcvd   MsgSent   TblVer  InQ OutQ  Up/Down State/PfxRcd",
    ...peers.map(([ip, as, state, up]) =>
      `${ip.padEnd(15)} 4 ${String(as).padStart(10)} ${String(phase === "post" ? 9213 : 9180).padStart(9)} ${String(phase === "post" ? 9208 : 9175).padStart(9)} ${String(1842).padStart(8)} ${String(0).padStart(4)} ${String(0).padStart(4)} ${up.padStart(8)} ${state}`),
    "",
    `Total number of neighbors ${peers.length}`,
  ].join("\n");
}

/** Answer one Conductor request, given whether the post-check is running. */
export function conductor(method, path, phase) {
  if (method === "POST" && path === "/api/v1/login") return { body: { token: "demo-session" } };
  if (path.startsWith("/api/v1/asset")) {
    return { body: ROUTERS.flatMap(([routerName, nodes]) => nodes.map((nodeName) => ({ routerName, nodeName, status: "RUNNING" }))) };
  }
  let r = path.match(/^\/api\/v1\/router\/([^/]+)\/(.*)$/);
  if (!r) return null;
  const [, router, rest] = r;
  const nodeOf = rest.match(/^node\/([^/]+)\/(.*)$/);
  if (rest.startsWith("bgp")) return { body: bgpText(router, phase) };
  if (rest.startsWith("ospf")) {
    return { body: [{ neighborId: "10.255.0.9", priority: 1, state: "Full/DR", deadTime: "00:00:35", address: "10.255.9.2", interface: "wan1" }] };
  }
  if (rest.startsWith("alarm")) {
    return { body: phase === "post" && router === "rtr-hq"
      ? [{ id: "a-77", severity: "major", category: "peer", message: "BGP peer 192.0.2.1 down", node: "rtr-hq-a" }]
      : [] };
  }
  if (rest.startsWith("stats/aggregate-session")) {
    return { body: [{ node: `${router}-a`, value: phase === "post" ? 1311 : 1287 }] };
  }
  if (nodeOf) {
    const [, node, what] = nodeOf;
    if (what === "networkInterface") {
      return { body: [
        { name: "wan1", type: "external", address: "203.0.113.10/30", operationalStatus: "OPER_UP", mtu: 1500 },
        { name: "lan1", type: "internal", address: "10.10.0.1/24", operationalStatus: "OPER_UP", mtu: 1500 },
      ] };
    }
    if (what === "deviceInterface") {
      return { body: [
        { name: "wan1-dev", pciAddress: "0000:02:00.0", operationalStatus: "OPER_UP", speed: 1000 },
        { name: "lan1-dev", pciAddress: "0000:03:00.0", operationalStatus: "OPER_UP", speed: 1000 },
      ] };
    }
    if (what === "adjacency") {
      return { body: [{ peer: "dc-east", status: phase === "post" && node === "rtr-hq-a" ? "DOWN" : "UP", latency: 12, loss: 0 }] };
    }
    if (what === "status") return { body: { node, status: "RUNNING", role: "combo", uptime: 1209600 } };
    if (what === "version") return { body: { node, version: "6.2.5-5.r2", build: "demo" } };
  }
  return null;
}
