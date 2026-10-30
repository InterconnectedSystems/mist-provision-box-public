// The data-shaping half of the switch port inventory, ported from
// mist_switch_port_inventory.py. Pure functions only — no fetch, no DOM — so
// the merge rules can be pinned in tests.
//
// The report draws one row per physical port by layering four sources onto a
// (mac, port_id) key: org port stats, device stats, per-site stats, and the
// switch's own port_config/port_usages. The fiddly part is virtual chassis:
// stats arrive against the chassis MAC, but each port belongs to the member in
// its FPC slot, so rows have to be re-attributed via fpcMembers().

export const norm_mac = (value) => (value === null || value === undefined
  ? "" : String(value).toLowerCase().replace(/[^0-9a-f]/g, ""));

export const norm_port = (value) => String(value ?? "").trim().toLowerCase();

const EMPTY = (v) => v === null || v === undefined || v === ""
  || (Array.isArray(v) && !v.length)
  || (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);

/** _first: the first key carrying a usable value, else `fallback`. */
export function first(obj, keys, fallback = "") {
  for (const k of keys) {
    if (obj && k in obj && obj[k] !== null && obj[k] !== undefined && obj[k] !== "") return obj[k];
  }
  return fallback;
}

export const switchKey = (sw) => norm_mac(sw.mac) || String(sw.id || sw.serial || "");

/** merge_switch: first writer wins per field; later sources only fill blanks. */
export function mergeSwitch(store, incoming) {
  const key = switchKey(incoming);
  if (!key) return;
  const current = store.get(key);
  if (!current) {
    const copied = { ...incoming };
    if (copied.mac) copied.mac = norm_mac(copied.mac) || copied.mac;
    if (copied.vc_mac) copied.vc_mac = norm_mac(copied.vc_mac) || copied.vc_mac;
    store.set(key, copied);
    return;
  }
  for (let [field, value] of Object.entries(incoming)) {
    if (EMPTY(value)) continue;
    if (field === "mac" || field === "vc_mac") value = norm_mac(value) || value;
    if (EMPTY(current[field])) current[field] = value;
  }
}

/** _as_switch_record */
export function asSwitchRecord(raw, siteId = null) {
  const status = raw.status;
  let connected = raw.connected;
  if ((connected === null || connected === undefined) && typeof status === "string") {
    connected = status.toLowerCase() === "connected";
  }
  return {
    id: raw.id || raw.device_id || "",
    mac: raw.mac || "",
    vc_mac: raw.vc_mac || raw.chassis_mac || "",
    name: raw.name || raw.hostname || "",
    hostname: raw.hostname || "",
    model: raw.model || "",
    serial: raw.serial || "",
    sku: raw.sku || "",
    site_id: raw.site_id || siteId || "",
    connected,
    status: typeof status === "string" ? status : "",
    adopted: raw.adopted,
    version: raw.version || "",
    vc_role: raw.vc_role || raw.role || "",
    member_id: raw.member_id ?? raw.fpc ?? raw.idx,
    type: raw.type || "switch",
  };
}

/** _member_record: a VC member row synthesised from its parent chassis. */
export function memberRecord(parent, member, index) {
  const parentMac = norm_mac(parent.mac);
  const vcMac = norm_mac(parent.vc_mac) || parentMac;
  const fpc = member.member_id ?? member.fpc ?? member.idx ?? index;
  let name = member.name || "";
  if (!name) {
    const base = parent.name || parent.hostname || vcMac || "vc";
    name = `${base} (fpc ${fpc})`;
  }
  return {
    id: member.id || "",
    mac: member.mac || "",
    vc_mac: vcMac,
    name,
    hostname: member.hostname || "",
    model: member.model || "",
    serial: member.serial || "",
    sku: member.sku || "",
    site_id: member.site_id || parent.site_id || "",
    connected: parent.connected,
    status: parent.status || "",
    adopted: parent.adopted,
    version: parent.version || "",
    vc_role: member.vc_role || member.role || "",
    member_id: fpc,
    type: "switch",
  };
}

export function isSecondaryVcMember(sw) {
  const mac = norm_mac(sw.mac);
  const vc = norm_mac(sw.vc_mac);
  return Boolean(mac && vc && mac !== vc);
}

/**
 * expand_port_key: Mist writes port_config keys as ranges and lists —
 * 'ge-0/0/0-3', 'ge-0/0/0-ge-0/0/3', 'ge-0/0/0,ge-0/0/10'. Zero padding in the
 * range start is preserved, because 'ge-0/0/00-03' means 00..03.
 */
export function expandPortKey(key) {
  const ports = [];
  for (const raw of String(key).split(",")) {
    const part = raw.trim();
    if (!part) continue;

    const full = /^([A-Za-z]+-[\d/]+)-([A-Za-z]+-[\d/]+)$/.exec(part);
    if (full) {
      const si = full[1].lastIndexOf("/");
      const ei = full[2].lastIndexOf("/");
      const startPrefix = full[1].slice(0, si);
      const startLast = full[1].slice(si + 1);
      const endPrefix = full[2].slice(0, ei);
      const endLast = full[2].slice(ei + 1);
      if (startPrefix === endPrefix && /^\d+$/.test(startLast) && /^\d+$/.test(endLast)) {
        const width = startLast.length;
        for (let i = Number(startLast); i <= Number(endLast); i += 1) {
          ports.push(`${startPrefix}/${width > 1 ? String(i).padStart(width, "0") : i}`);
        }
        continue;
      }
    }

    if (part.includes("/")) {
      const idx = part.lastIndexOf("/");
      const prefix = part.slice(0, idx);
      const last = part.slice(idx + 1);
      if (last.includes("-")) {
        const [startS, endS] = last.split("-", 2);
        if (/^\d+$/.test(startS) && /^\d+$/.test(endS)) {
          const width = startS.length;
          for (let i = Number(startS); i <= Number(endS); i += 1) {
            ports.push(`${prefix}/${width > 1 ? String(i).padStart(width, "0") : i}`);
          }
          continue;
        }
      }
    }
    ports.push(part);
  }
  return ports.length ? ports : [key];
}

export function fpcFromPort(portId) {
  const m = /^[a-z]+-(\d+)\//.exec(norm_port(portId));
  return m ? Number(m[1]) : null;
}

export function fmtSpeedDuplex(speed, fullDuplex, duplex = null) {
  let speedTxt;
  if (speed === null || speed === undefined || speed === "" || speed === 0 || speed === "0") {
    speedTxt = "";
  } else {
    const n = Number(speed);
    if (Number.isInteger(n)) speedTxt = n >= 1000 && n % 1000 === 0 ? `${n / 1000}G` : `${n}M`;
    else speedTxt = String(speed);
  }
  let dupTxt = "";
  if (duplex === "full" || duplex === "half") dupTxt = duplex;
  else if (fullDuplex === true) dupTxt = "full";
  else if (fullDuplex === false) dupTxt = "half";

  if (speedTxt && dupTxt) return `${speedTxt}/${dupTxt}`;
  return speedTxt || dupTxt;
}

export function portStatus(up, disabled) {
  if (disabled === true) return "disabled";
  if (up === true) return "up";
  if (up === false) return "down";
  return "";
}

/** extract_stat_ports: device stats carry ports under three different keys. */
export function extractStatPorts(st) {
  const found = [];
  for (const key of ["ports", "port_stat", "interfaces"]) {
    const value = st?.[key];
    if (Array.isArray(value)) {
      for (const p of value) if (p && typeof p === "object") found.push(p);
    } else if (value && typeof value === "object") {
      for (const [pid, p] of Object.entries(value)) {
        // setdefault("port_id", pid): the port's own id wins, the map key fills in.
        if (p && typeof p === "object") found.push({ port_id: pid, ...p });
      }
    }
  }
  return found;
}

/**
 * harvest_port_config: flatten a switch's port_config, resolving each entry's
 * `usage` against port_usages, and expand range keys to individual ports.
 * @returns {boolean} whether anything was harvested
 */
export function harvestPortConfig(cfg, mac, mapping) {
  const portConfig = cfg?.port_config;
  if (!portConfig || typeof portConfig !== "object" || !Object.keys(portConfig).length) return false;
  const portUsages = cfg.port_usages && typeof cfg.port_usages === "object" ? cfg.port_usages : {};

  for (const [portKey, pcfg] of Object.entries(portConfig)) {
    if (!pcfg || typeof pcfg !== "object") continue;
    const usage = pcfg.usage || pcfg.dynamic_usage || "";
    const usageDef = portUsages[usage] && typeof portUsages[usage] === "object" ? portUsages[usage] : {};
    const networks = usageDef.networks;
    const networksTxt = Array.isArray(networks) ? networks.map(String).join(",") : (networks || "");

    const record = {
      usage,
      description: pcfg.description || usageDef.description || "",
      disabled: pcfg.disabled,
      speed: pcfg.speed || usageDef.speed,
      duplex: pcfg.duplex || usageDef.duplex,
      poe_disabled: "poe_disabled" in pcfg ? pcfg.poe_disabled : usageDef.poe_disabled,
      mode: usageDef.mode || pcfg.mode,
      port_network: usageDef.port_network || pcfg.port_network,
      networks: networksTxt,
      port_auth: usageDef.port_auth || pcfg.port_auth,
    };
    for (const expanded of expandPortKey(String(portKey))) {
      mapping.set(`${mac}|${norm_port(expanded)}`, record);
    }
  }
  return true;
}

/** _index_switches: by MAC and by serial, with VC MACs pointing at a member. */
export function indexSwitches(switches) {
  const byMac = new Map();
  const bySerial = new Map();
  for (const sw of switches) {
    const mac = norm_mac(sw.mac);
    if (mac) byMac.set(mac, sw);
    const serial = String(sw.serial || "").toUpperCase();
    if (serial) bySerial.set(serial, sw);
  }
  for (const sw of switches) {
    const vc = norm_mac(sw.vc_mac);
    const mac = norm_mac(sw.mac);
    if (vc && !byMac.has(vc)) byMac.set(vc, sw);
    else if (vc && mac === vc) byMac.set(vc, sw);
  }
  return { byMac, bySerial };
}

/**
 * _fpc_members: (chassisMac, fpc) -> the member switch in that slot, so a port
 * reported against the chassis is attributed to the right physical unit.
 */
export function fpcMembers(switches, switchStats, byMac, bySerial) {
  const mapping = new Map();
  const put = (mac, fpc, sw) => { if (mac) mapping.set(`${mac}|${fpc}`, sw); };

  for (const sw of switches) {
    const mac = norm_mac(sw.mac);
    const vc = norm_mac(sw.vc_mac);
    if (!mac || !vc || mac === vc) continue;
    const idx = sw.member_id;
    if (idx === null || idx === undefined || idx === "") continue;
    const fpc = Number(idx);
    if (!Number.isInteger(fpc)) continue;
    put(vc, fpc, sw);
  }

  for (const st of switchStats) {
    const reporting = norm_mac(st.mac);
    const vc = norm_mac(st.vc_mac) || reporting;
    for (const mod of st.module_stat || []) {
      if (!mod || typeof mod !== "object") continue;
      const idx = mod.idx ?? mod.fpc;
      if (idx === null || idx === undefined || idx === "") continue;
      const fpc = Number(idx);
      if (!Number.isInteger(fpc)) continue;

      let member = null;
      const serial = String(mod.serial || "").toUpperCase();
      if (serial) member = bySerial.get(serial) || null;
      const mmac = norm_mac(mod.mac);
      if (!member && mmac) member = byMac.get(mmac) || null;
      if (!member) continue;
      put(reporting, fpc, member);
      put(vc, fpc, member);
    }
  }
  return mapping;
}

export const PORT_COLUMNS = [
  "Site", "Site ID", "Switch Name", "Switch Model", "Switch MAC", "VC MAC", "Switch Serial",
  "Switch Status", "Firmware", "Switch IP", "Port", "Port Description", "Port Usage / Profile",
  "Port Status", "Admin Disabled", "Link Up", "Speed (Mbps)", "Duplex", "Speed/Duplex", "Uplink",
  "Mode (access/trunk)", "Port Network / Native VLAN", "Allowed Networks / VLANs", "Port Auth",
  "Auth State", "PoE On", "PoE Mode", "PoE Disabled (config)", "PoE Power Draw (W)",
  "Neighbor System Name", "Neighbor Port", "Neighbor MAC", "STP State", "STP Role",
  "TX bps", "RX bps", "TX bytes", "RX bytes", "TX errors", "RX errors", "Port MAC",
];

const boolTxt = (v) => (v === null || v === undefined || v === "" ? "" : String(Boolean(v)));

/**
 * build_port_rows: one row per (switch MAC, port id), merged across every
 * source and attributed to the correct VC member.
 */
export function buildPortRows(sites, switches, orgPorts, switchStats, portConfigs) {
  const siteById = new Map(sites.filter((s) => s.id).map((s) => [s.id, s]));
  const { byMac: switchByMac, bySerial } = indexSwitches(switches);
  const fpcMember = fpcMembers(switches, switchStats, switchByMac, bySerial);

  const statsByMac = new Map();
  for (const st of switchStats) {
    const mac = norm_mac(st.mac);
    if (mac) statsByMac.set(mac, st);
  }

  const portsByKey = new Map();
  const remember = (mac, portId, payload) => {
    const nmac = norm_mac(mac);
    const npid = norm_port(portId);
    if (!nmac || !npid) return;
    const key = `${nmac}|${npid}`;
    const existing = portsByKey.get(key) || {};
    const merged = { ...existing };
    for (const [k, v] of Object.entries(payload)) {
      if (v !== null && v !== undefined && v !== "") merged[k] = v;
    }
    merged.mac = nmac;
    merged.port_id = payload.port_id || existing.port_id || npid;
    portsByKey.set(key, merged);
  };

  for (const port of orgPorts) {
    if (!port || typeof port !== "object") continue;
    const mac = norm_mac(port.mac || port.device_mac);
    const portId = port.port_id || port.port || "";
    if (mac && portId) remember(mac, portId, port);
  }

  for (const st of switchStats) {
    if (!st || typeof st !== "object") continue;
    const mac = norm_mac(st.mac);
    for (const port of extractStatPorts(st)) {
      const portId = port.port_id || port.port || port.name || "";
      if (!mac || !portId) continue;
      const payload = { ...port };
      if (payload.mac === undefined) payload.mac = mac;
      if (payload.site_id === undefined) payload.site_id = st.site_id;
      if (payload.device_name === undefined) payload.device_name = st.name;
      remember(mac, portId, payload);
    }
  }

  // A port that is configured but reported nowhere still belongs in the export.
  for (const key of portConfigs.keys()) {
    if (!portsByKey.has(key)) {
      const [mac, portId] = key.split("|");
      remember(mac, portId, { mac, port_id: portId });
    }
  }

  const rows = [];
  const keys = [...portsByKey.keys()].sort();
  for (const key of keys) {
    const port = portsByKey.get(key);
    const [mac, portId] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
    const reporting = switchByMac.get(mac) || {};
    let st = statsByMac.get(mac) || {};
    if (!Object.keys(st).length) {
      const vcLookup = norm_mac(reporting.vc_mac);
      if (vcLookup) st = statsByMac.get(vcLookup) || {};
    }
    const siteId = port.site_id || reporting.site_id || st.site_id || "";
    const site = siteById.get(siteId) || {};

    let display = reporting;
    let vcMac = norm_mac(port.vc_mac || reporting.vc_mac || st.vc_mac);
    const fpc = fpcFromPort(portId);
    if (fpc !== null) {
      const member = fpcMember.get(`${mac}|${fpc}`)
        || (vcMac ? fpcMember.get(`${vcMac}|${fpc}`) : null);
      if (member) {
        display = member;
        vcMac = vcMac || norm_mac(member.vc_mac) || mac;
      }
    }

    let cfg = portConfigs.get(`${norm_mac(display.mac)}|${portId}`);
    if (!cfg) cfg = portConfigs.get(`${mac}|${portId}`);
    if (!cfg && vcMac) cfg = portConfigs.get(`${vcMac}|${portId}`);
    cfg = cfg || {};

    const speed = first(port, ["speed"], first(cfg, ["speed"]));
    const fullDuplex = port.full_duplex;
    const duplex = first(port, ["duplex"], first(cfg, ["duplex"]));
    const up = port.up;
    let disabled = cfg.disabled;
    if (disabled === null || disabled === undefined) disabled = port.disabled;

    const description = first(port, ["description", "port_desc", "desc", "if_descr"])
      || cfg.description || "";
    const usage = first(port, ["port_usage", "usage", "profile"]) || cfg.usage || "";
    let swStatus = first(st, ["status"]);
    if (!swStatus) {
      if (reporting.connected === true || display.connected === true) swStatus = "connected";
      else if (reporting.connected === false) swStatus = "disconnected";
    }

    rows.push({
      Site: site.name || "",
      "Site ID": siteId,
      "Switch Name": first(display, ["name", "hostname"]) || first(st, ["name"])
        || first(reporting, ["name", "hostname"]) || "",
      "Switch Model": first(display, ["model"]) || first(st, ["model"]) || first(reporting, ["model"]) || "",
      "Switch MAC": norm_mac(display.mac) || mac,
      "VC MAC": vcMac && vcMac !== norm_mac(display.mac) ? vcMac : "",
      "Switch Serial": first(display, ["serial"]) || first(st, ["serial"]) || first(reporting, ["serial"]) || "",
      "Switch Status": swStatus || "",
      Firmware: first(st, ["version"], first(reporting, ["version"])) || "",
      "Switch IP": first(st, ["ip"]) || "",
      Port: port.port_id || portId,
      "Port Description": description,
      "Port Usage / Profile": usage,
      "Port Status": portStatus(up, disabled),
      "Admin Disabled": boolTxt(disabled),
      "Link Up": boolTxt(up),
      "Speed (Mbps)": speed === null || speed === undefined || speed === "" ? "" : speed,
      Duplex: fullDuplex === true ? "full" : (fullDuplex === false ? "half" : (duplex || "")),
      "Speed/Duplex": fmtSpeedDuplex(speed, fullDuplex, duplex),
      Uplink: boolTxt(port.uplink),
      "Mode (access/trunk)": cfg.mode || first(port, ["mode"]) || "",
      "Port Network / Native VLAN": cfg.port_network || first(port, ["port_network", "vlan"]) || "",
      "Allowed Networks / VLANs": cfg.networks || first(port, ["networks", "vlans"]) || "",
      "Port Auth": cfg.port_auth || first(port, ["port_auth", "auth_state"]) || "",
      "Auth State": first(port, ["auth_state"]) || "",
      "PoE On": boolTxt(port.poe_on),
      "PoE Mode": first(port, ["poe_mode"]) || "",
      "PoE Disabled (config)": boolTxt(cfg.poe_disabled),
      "PoE Power Draw (W)": first(port, ["power_draw", "poe_power_draw"]) || "",
      "Neighbor System Name": first(port, ["neighbor_system_name"]) || "",
      "Neighbor Port": first(port, ["neighbor_port_desc", "neighbor_port_id"]) || "",
      "Neighbor MAC": first(port, ["neighbor_mac"]) || "",
      "STP State": first(port, ["stp_state"]) || "",
      "STP Role": first(port, ["stp_role"]) || "",
      "TX bps": first(port, ["tx_bps"]) || "",
      "RX bps": first(port, ["rx_bps"]) || "",
      "TX bytes": first(port, ["tx_bytes"]) || "",
      "RX bytes": first(port, ["rx_bytes"]) || "",
      "TX errors": first(port, ["tx_errors"]) || "",
      "RX errors": first(port, ["rx_errors"]) || "",
      "Port MAC": first(port, ["port_mac"]) || "",
    });
  }
  return rows;
}

export function portCoverage(rows) {
  const owners = new Set();
  const vcs = new Set();
  for (const r of rows) {
    const o = norm_mac(r["Switch MAC"]);
    if (o) owners.add(o);
    const v = norm_mac(r["VC MAC"]);
    if (v) vcs.add(v);
  }
  return { owners, vcs };
}

export function switchHasPorts(sw, owners, vcs) {
  const mac = norm_mac(sw.mac);
  const vc = norm_mac(sw.vc_mac);
  if (mac && (owners.has(mac) || vcs.has(mac))) return true;
  if (vc && (owners.has(vc) || vcs.has(vc))) return true;
  return false;
}
