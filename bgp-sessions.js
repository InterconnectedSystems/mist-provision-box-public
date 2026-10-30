/**
 * BGP Sessions
 * Switch BGP, WAN-edge BGP, and SSR/SRX peer paths for one site or a whole org.
 * Install from the toolbox: Manage tools, choose this file, Install.
 *
 * Reads, in parallel, never once per site:
 *   GET /orgs/{org}/stats/devices?type=switch
 *   GET /orgs/{org}/stats/devices?type=gateway
 *   GET /orgs/{org}/stats/bgp_peers/search
 *   GET /orgs/{org}/stats/vpn_peers/search     (peer paths: svr = SSR, ipsec = SRX)
 */
export default {
  id: "bgp-sessions",
  name: "BGP Sessions",
  description:
    "Live switch BGP, WAN-edge BGP, and every SSR or SRX peer path for one site or the whole org. One org-wide pass, then a color board you can open full screen.",
  tag: "Routing",
  notice:
    "Read-only live stats. Switch and WAN-edge sessions come from Mist BGP peer stats (the WAN Topology Details source), split by device type. Peer paths are the SSR svr and SRX ipsec paths on each WAN edge. Mist does not report a local interface on the BGP stat, so sessions are keyed by VRF, neighbor, and HA node.",
  needs: { mistToken: true, org: true },
  scope: "site",
  params: [
    {
      id: "duration",
      type: "select",
      label: "Lookback",
      default: "1d",
      options: [
        { value: "1h", label: "Last hour" },
        { value: "6h", label: "Last 6 hours" },
        { value: "1d", label: "Last day" },
        { value: "7d", label: "Last 7 days" },
      ],
      hint: "Sessions seen in this window. The newest sample is kept for each neighbor or path.",
    },
    { id: "switches", type: "checkbox", label: "Switch BGP", default: true },
    { id: "wan", type: "checkbox", label: "WAN edge BGP", default: true },
    { id: "paths", type: "checkbox", label: "WAN edge peer paths", default: true },
  ],

  async run(ctx) {
    const showSw = ctx.params.switches !== false;
    const showWan = ctx.params.wan !== false;
    const showPaths = ctx.params.paths !== false;
    if (!showSw && !showWan && !showPaths) {
      throw new Error("Pick at least one of switch BGP, WAN-edge BGP, or peer paths.");
    }
    if (ctx.signal && ctx.signal.aborted) throw new Error("Cancelled");

    const scope = await ctx.targetSites();
    if (!scope.sites.length) throw new Error("This org has no sites.");

    const siteName = new Map();
    for (const site of scope.orgSites || []) siteName.set(site.id, site.name);
    for (const site of scope.sites) siteName.set(site.id, site.name);
    const siteIds = new Set(scope.sites.map((site) => site.id));

    const duration = ctx.params.duration || "1d";
    const query = { limit: 1000, duration };
    if (!scope.all && scope.sites.length === 1) query.site_id = scope.sites[0].id;

    const jobs = [];
    jobs.push(["Switches", () => ctx.getAll(`/orgs/${ctx.orgId}/stats/devices`, { type: "switch" })]);
    jobs.push(["WAN edges", () => ctx.getAll(`/orgs/${ctx.orgId}/stats/devices`, { type: "gateway" })]);
    if (showSw || showWan) {
      jobs.push(["BGP peers", () => ctx.searchAll(`/orgs/${ctx.orgId}/stats/bgp_peers/search`, query)]);
    }
    if (showPaths) {
      jobs.push(["Peer paths", () => ctx.searchAll(`/orgs/${ctx.orgId}/stats/vpn_peers/search`, query)]);
    }

    ctx.status("Reading " + scope.label);
    ctx.log(
      scope.label + " · " + jobs.length + " org calls (not one per site)",
      "info",
    );
    ctx.progress(0, jobs.length, "Starting");

    let finished = 0;
    const results = {};
    const failures = [];
    await Promise.all(
      jobs.map(async ([label, fn]) => {
        try {
          const data = await fn();
          if (ctx.signal && ctx.signal.aborted) throw new Error("Cancelled");
          const rows = Array.isArray(data) ? data : [];
          results[label] = { ok: true, rows };
          ctx.log(label + " · " + rows.length + " rows", "ok");
        } catch (err) {
          if (ctx.signal && ctx.signal.aborted) throw new Error("Cancelled");
          if (err && err.message === "Cancelled") throw err;
          const msg = err && err.message ? err.message : "request failed";
          results[label] = { ok: false, rows: [] };
          failures.push(label + ": " + msg);
          ctx.log(label + " failed · " + msg, "err");
        } finally {
          finished += 1;
          ctx.progress(finished, jobs.length, label);
        }
      }),
    );

    const required = [];
    if (showSw || showWan) required.push("BGP peers");
    if (showPaths) required.push("Peer paths");
    if (required.length && required.every((label) => results[label] && !results[label].ok)) {
      throw new Error(failures.join(" · ") || "Mist did not return BGP or peer-path stats.");
    }

    const devices = new Map();
    for (const row of (results.Switches && results.Switches.rows) || []) indexDevice(devices, row, "switch");
    for (const row of (results["WAN edges"] && results["WAN edges"].rows) || []) {
      indexDevice(devices, row, "gateway");
    }

    const rawBgp = dedupe((results["BGP peers"] && results["BGP peers"].rows) || [], bgpKey);
    const rawPaths = dedupe((results["Peer paths"] && results["Peer paths"].rows) || [], pathKey);

    const sessions = [];
    for (const row of rawBgp) {
      if (row.site_id && !siteIds.has(row.site_id)) continue;
      const dev = devices.get(normMac(row.mac));
      const roleKey = roleOf(row, dev);
      if (roleKey === "switch" && !showSw) continue;
      if (roleKey === "wan" && !showWan) continue;
      if (roleKey === "other" && !showSw && !showWan) continue;
      sessions.push(toSession(ctx, row, dev, roleKey, siteName, devices));
    }
    sessions.sort(byProblem);

    const paths = [];
    for (const row of rawPaths) {
      if (row.site_id && !siteIds.has(row.site_id)) continue;
      paths.push(toPath(ctx, row, devices, siteName));
    }
    paths.sort(byProblem);

    const summary = summarize(sessions, paths, scope.label, failures);
    ctx.log(summary, sessions.some((row) => row.tone !== "up") || paths.some((row) => row.tone !== "up") ? "err" : "ok");
    ctx.status(summary);

    if (ctx.mount) paint(ctx, { org: ctx.orgName, scope: scope.label, sessions, paths, failures });

    const switchRows = sessions.filter((row) => row.roleKey === "switch");
    const wanRows = sessions.filter((row) => row.roleKey === "wan");
    const otherRows = sessions.filter((row) => row.roleKey === "other");
    const problems = problemRows(sessions, paths);
    const sheets = [];
    if (showSw) {
      sheets.push(ctx.xlsx.sheet("Switch BGP", SESSION_COLUMNS, switchRows.map(sessionSheet), { tabColor: "1F4E78" }));
    }
    if (showWan) {
      sheets.push(ctx.xlsx.sheet("WAN edge BGP", SESSION_COLUMNS, wanRows.map(sessionSheet), { tabColor: "0F6E56" }));
    }
    if (otherRows.length) {
      sheets.push(ctx.xlsx.sheet("Other BGP", SESSION_COLUMNS, otherRows.map(sessionSheet), { tabColor: "5C4B8A" }));
    }
    if (showPaths) {
      sheets.push(ctx.xlsx.sheet("Peer paths", PATH_COLUMNS, paths.map(pathSheet), { tabColor: "7A4E12" }));
    }
    sheets.push(ctx.xlsx.sheet("Problems", PROBLEM_COLUMNS, problems, { tabColor: "8C2F39" }));
    sheets.push(
      ctx.xlsx.sheet("By site", SITE_COLUMNS, siteRollup(sessions, paths), {
        tabColor: "243028",
      }),
    );

    const previewRows = (problems.length ? problems : sessions.map(sessionSheet)).slice(0, 200);
    return {
      summary,
      filename: ctx.stampedName("bgp_sessions", scope.fileLabel || ctx.orgName, "xlsx"),
      sheets,
      preview: {
        title: problems.length ? "Needs attention" : "BGP sessions",
        columns: problems.length ? PROBLEM_COLUMNS : SESSION_COLUMNS,
        rows: previewRows,
      },
    };
  },
};

const SESSION_COLUMNS = [
  { header: "Site", key: "site", width: 22 },
  { header: "Role", key: "role", width: 12 },
  { header: "Device", key: "device", width: 22 },
  { header: "MAC", key: "mac", width: 20 },
  { header: "Model", key: "model", width: 16 },
  { header: "Node", key: "node", width: 10 },
  { header: "VRF", key: "vrf", width: 18 },
  { header: "Router ID", key: "routerId", width: 16 },
  { header: "Neighbor", key: "neighbor", width: 18 },
  { header: "Neighbor name", key: "neighborName", width: 22 },
  { header: "Neighbor MAC", key: "neighborMac", width: 20 },
  { header: "Local AS", key: "localAs", width: 12 },
  { header: "Neighbor AS", key: "neighborAs", width: 14 },
  { header: "State", key: "stateLabel", width: 14 },
  { header: "Up", key: "upLabel", width: 8 },
  { header: "Kind", key: "overlay", width: 12 },
  { header: "Rx routes", key: "rxRoutes", width: 12 },
  { header: "Tx routes", key: "txRoutes", width: 12 },
  { header: "Rx packets", key: "rxPkts", width: 14 },
  { header: "Tx packets", key: "txPkts", width: 14 },
  { header: "Uptime", key: "uptimeLabel", width: 12 },
  { header: "Flaps", key: "flaps", width: 10 },
  { header: "Last sample", key: "lastSample", width: 22 },
];

const PATH_COLUMNS = [
  { header: "Site", key: "site", width: 22 },
  { header: "WAN edge", key: "device", width: 22 },
  { header: "MAC", key: "mac", width: 20 },
  { header: "Model", key: "model", width: 16 },
  { header: "Node", key: "node", width: 10 },
  { header: "Interface", key: "iface", width: 16 },
  { header: "Peer", key: "peer", width: 22 },
  { header: "Peer site", key: "peerSite", width: 22 },
  { header: "Peer MAC", key: "peerMac", width: 20 },
  { header: "Peer interface", key: "peerIface", width: 16 },
  { header: "Kind", key: "kind", width: 16 },
  { header: "Up", key: "upLabel", width: 8 },
  { header: "Active", key: "activeLabel", width: 10 },
  { header: "Latency ms", key: "latency", width: 12 },
  { header: "Jitter ms", key: "jitter", width: 12 },
  { header: "Loss %", key: "loss", width: 10 },
  { header: "MOS", key: "mos", width: 8 },
  { header: "MTU", key: "mtu", width: 8 },
  { header: "Uptime", key: "uptimeLabel", width: 12 },
  { header: "Last seen", key: "lastSample", width: 22 },
];

const PROBLEM_COLUMNS = [
  { header: "Type", key: "type", width: 16 },
  { header: "Site", key: "site", width: 22 },
  { header: "Device", key: "device", width: 22 },
  { header: "Detail", key: "detail", width: 36 },
  { header: "Peer", key: "peer", width: 28 },
  { header: "State", key: "state", width: 14 },
  { header: "Metric", key: "metric", width: 28 },
  { header: "Uptime", key: "uptime", width: 12 },
];

const SITE_COLUMNS = [
  { header: "Site", key: "site", width: 24 },
  { header: "Switch BGP", key: "switchBgp", width: 14 },
  { header: "Switch down", key: "switchDown", width: 14 },
  { header: "WAN BGP", key: "wanBgp", width: 12 },
  { header: "WAN down", key: "wanDown", width: 12 },
  { header: "Peer paths", key: "paths", width: 12 },
  { header: "Paths down", key: "pathsDown", width: 14 },
];

function sessionSheet(row) {
  return {
    site: row.site,
    role: row.role,
    device: row.device,
    mac: row.mac,
    model: row.model,
    node: row.node,
    vrf: row.vrf,
    routerId: row.routerId,
    neighbor: row.neighbor,
    neighborName: row.neighborName,
    neighborMac: row.neighborMac,
    localAs: row.localAs,
    neighborAs: row.neighborAs,
    stateLabel: row.stateLabel,
    upLabel: row.upLabel,
    overlay: row.overlay,
    rxRoutes: row.rxRoutes,
    txRoutes: row.txRoutes,
    rxPkts: row.rxPkts,
    txPkts: row.txPkts,
    uptimeLabel: row.uptimeLabel,
    flaps: row.flaps,
    lastSample: row.lastSample,
    __style: row.tone === "up" ? "green" : row.tone === "down" ? "red" : "yellow",
  };
}

function pathSheet(row) {
  return {
    site: row.site,
    device: row.device,
    mac: row.mac,
    model: row.model,
    node: row.node,
    iface: row.iface,
    peer: row.peer,
    peerSite: row.peerSite,
    peerMac: row.peerMac,
    peerIface: row.peerIface,
    kind: row.kind,
    upLabel: row.upLabel,
    activeLabel: row.activeLabel,
    latency: row.latency,
    jitter: row.jitter,
    loss: row.loss,
    mos: row.mos,
    mtu: row.mtu,
    uptimeLabel: row.uptimeLabel,
    lastSample: row.lastSample,
    __style: row.tone === "up" ? "green" : row.tone === "down" ? "red" : "yellow",
  };
}

function problemRows(sessions, paths) {
  const rows = [];
  for (const row of sessions) {
    const fresh = isFresh(row);
    if (row.tone === "up" && !fresh) continue;
    rows.push({
      type: row.role + " BGP",
      site: row.site,
      device: row.device,
      detail: [row.vrf, row.overlay, row.node].filter(Boolean).join(" · "),
      peer: row.neighbor + (row.neighborName ? " · " + row.neighborName : "") + " AS " + row.neighborAs,
      state: fresh && row.tone === "up" ? "Established < 12h" : row.stateLabel,
      metric: (row.rxRoutes || 0) + " rx / " + (row.txRoutes || 0) + " tx routes",
      uptime: row.uptimeLabel,
      __style: fresh && row.tone === "up" ? "yellow" : row.tone === "down" ? "red" : "yellow",
    });
  }
  for (const row of paths) {
    if (row.tone === "up") continue;
    rows.push({
      type: "Peer path",
      site: row.site,
      device: row.device,
      detail: row.iface + " → " + (row.peerIface || "peer") + " · " + row.kind,
      peer: row.peer + (row.peerSite ? " · " + row.peerSite : ""),
      state: row.upLabel,
      metric: "loss " + num(row.loss) + "% · " + num(row.latency) + " ms · MOS " + num(row.mos),
      uptime: row.uptimeLabel,
      __style: row.tone === "down" ? "red" : "yellow",
    });
  }
  return rows;
}

function siteRollup(sessions, paths) {
  const map = new Map();
  const ensure = (site) => {
    if (!map.has(site)) {
      map.set(site, { site, switchBgp: 0, switchDown: 0, wanBgp: 0, wanDown: 0, paths: 0, pathsDown: 0 });
    }
    return map.get(site);
  };
  for (const row of sessions) {
    const item = ensure(row.site || "Unknown");
    if (row.roleKey === "switch") {
      item.switchBgp += 1;
      if (row.tone !== "up") item.switchDown += 1;
    } else {
      item.wanBgp += 1;
      if (row.tone !== "up") item.wanDown += 1;
    }
  }
  for (const row of paths) {
    const item = ensure(row.site || "Unknown");
    item.paths += 1;
    if (row.tone !== "up") item.pathsDown += 1;
  }
  const rows = [...map.values()].sort((a, b) => a.site.localeCompare(b.site));
  const total = { site: "Total", switchBgp: 0, switchDown: 0, wanBgp: 0, wanDown: 0, paths: 0, pathsDown: 0, __style: "bold" };
  for (const row of rows) {
    const down = row.switchDown + row.wanDown + row.pathsDown;
    row.__style = down === 0 ? "green" : down < 3 ? "yellow" : "red";
    total.switchBgp += row.switchBgp;
    total.switchDown += row.switchDown;
    total.wanBgp += row.wanBgp;
    total.wanDown += row.wanDown;
    total.paths += row.paths;
    total.pathsDown += row.pathsDown;
  }
  rows.push(total);
  return rows;
}

function summarize(sessions, paths, label, failures) {
  const bgpUp = sessions.filter((row) => row.tone === "up").length;
  const pathUp = paths.filter((row) => row.tone === "up").length;
  let text =
    bgpUp +
    " of " +
    sessions.length +
    " BGP sessions up · " +
    pathUp +
    " of " +
    paths.length +
    " peer paths up · " +
    label;
  if (failures.length) text += " · " + failures.length + " call" + (failures.length === 1 ? "" : "s") + " failed";
  return text;
}

function toSession(ctx, row, dev, roleKey, siteName, devices) {
  const neighborDev = devices.get(normMac(row.neighbor_mac));
  const named = deviceName(neighborDev);
  const state = String(row.state || "");
  const up = row.up === true || state === "established";
  const tone = sessionTone(state, row.up);
  const role = roleKey === "switch" ? "Switch" : roleKey === "wan" ? "WAN edge" : "Other";
  return {
    roleKey,
    role,
    site: siteName.get(row.site_id) || (dev && dev.siteName) || "",
    siteId: row.site_id || "",
    device: deviceName(dev) || row.model || fmtMac(ctx, row.mac) || "Unknown",
    model: row.model || (dev && dev.model) || "",
    mac: fmtMac(ctx, row.mac),
    node: row.node || "",
    vrf: row.vrf_name || "",
    routerId: row.router_id || "",
    neighbor: row.neighbor || "",
    neighborAs: asText(row.neighbor_as),
    neighborMac: fmtMac(ctx, row.neighbor_mac),
    neighborName: named,
    localAs: asText(row.local_as),
    state,
    stateLabel: stateLabel(state),
    up,
    upLabel: row.up === false ? "no" : up ? "yes" : "",
    overlay: row.evpn_overlay ? "EVPN" : row.for_overlay ? "Overlay" : "Underlay",
    rxRoutes: numOrBlank(row.rx_routes),
    txRoutes: numOrBlank(row.tx_routes),
    rxPkts: numOrBlank(row.rx_pkts),
    txPkts: numOrBlank(row.tx_pkts),
    flaps: numOrBlank(row.flap_count),
    uptimeLabel: fmtUptime(row.uptime),
    uptimeSec: uptimeSeconds(row.uptime),
    lastSample: stamp(ctx, row.timestamp),
    tone,
    hay: "",
  };
}

function toPath(ctx, row, devices, siteName) {
  const dev = devices.get(normMac(row.mac));
  const peerDev = devices.get(normMac(row.peer_mac));
  const up = row.up === true;
  const loss = Number(row.loss);
  const mosN = mosScore(row.mos);
  const tone = pathTone(up, loss, mosN);
  const peer = row.peer_router_name || deviceName(peerDev) || fmtMac(ctx, row.peer_mac) || "Peer";
  return {
    site: siteName.get(row.site_id) || (dev && dev.siteName) || "",
    siteId: row.site_id || "",
    device: row.router_name || deviceName(dev) || fmtMac(ctx, row.mac) || "WAN edge",
    model: (dev && dev.model) || "",
    mac: fmtMac(ctx, row.mac),
    node: row.node || "",
    iface: row.port_id || "",
    peer,
    peerSite: siteName.get(row.peer_site_id) || "",
    peerMac: fmtMac(ctx, row.peer_mac),
    peerIface: row.peer_port_id || "",
    kind: pathKind(row.type),
    up,
    upLabel: row.up === false ? "no" : up ? "yes" : "",
    activeLabel: row.is_active === true ? "active" : row.is_active === false ? "standby" : "",
    latency: numOrBlank(row.latency),
    jitter: numOrBlank(row.jitter),
    loss: numOrBlank(row.loss),
    mos: fmtMos(row.mos),
    mtu: numOrBlank(row.mtu),
    uptimeLabel: fmtUptime(row.uptime),
    uptimeSec: uptimeSeconds(row.uptime),
    lastSample: stamp(ctx, row.last_seen),
    tone,
  };
}

function indexDevice(map, row, type) {
  const mac = normMac(row.mac);
  if (!mac) return;
  map.set(mac, {
    mac,
    type: row.type || type,
    model: row.model || "",
    name: row.name || row.hostname || "",
    siteId: row.site_id || "",
    siteName: "",
  });
}

function deviceName(dev) {
  if (!dev) return "";
  return dev.name || "";
}

function roleOf(row, dev) {
  const type = dev && dev.type;
  if (type === "switch") return "switch";
  if (type === "gateway") return "wan";
  const model = String((row && row.model) || (dev && dev.model) || "");
  if (/^(SSR|SRX|VSRX|NFX)/i.test(model)) return "wan";
  if (/^(EX|QFX)/i.test(model)) return "switch";
  return "other";
}

function sessionTone(state, up) {
  if (state === "established") return "up";
  if (state === "idle") return "down";
  if (up === true) return "up";
  if (up === false && !state) return "down";
  return "warn";
}

function pathTone(up, loss, mos) {
  if (up === false) return "down";
  const lossBad = Number.isFinite(loss) && loss > 0;
  const mosBad = Number.isFinite(mos) && mos < 4;
  if (up === true && (lossBad || mosBad)) return "warn";
  if (up === true) return "up";
  return "warn";
}

function mosScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  return n > 5 ? n / 100 : n;
}

function uptimeSeconds(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isFresh(row) {
  return row.state === "established" && row.uptimeSec != null && row.uptimeSec < 12 * 3600;
}

function stateLabel(state) {
  if (state === "established") return "Established";
  if (state === "open_sent") return "Open sent";
  if (state === "open_config") return "OpenConfirm";
  if (state === "idle") return "Idle";
  if (state === "active") return "Active";
  if (state === "connect") return "Connect";
  if (!state) return "Unknown";
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function pathKind(type) {
  const value = String(type || "").toLowerCase();
  if (value === "svr") return "SSR peer path";
  if (value === "ipsec") return "SRX IPsec";
  return type || "Path";
}

function bgpKey(row) {
  return [normMac(row.mac), row.node || "", row.vrf_name || "", row.neighbor || "", asText(row.neighbor_as)].join("|");
}

function pathKey(row) {
  return [normMac(row.mac), row.node || "", row.port_id || "", normMac(row.peer_mac), row.peer_port_id || "", row.type || ""].join("|");
}

function dedupe(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const prev = map.get(key);
    const stampOf = (item) => Number(item && (item.timestamp || item.last_seen)) || 0;
    if (!prev || stampOf(row) >= stampOf(prev)) map.set(key, row);
  }
  return [...map.values()];
}

function byProblem(a, b) {
  const rank = { down: 0, warn: 1, up: 2 };
  return (rank[a.tone] - rank[b.tone]) || String(a.site).localeCompare(String(b.site)) || String(a.device).localeCompare(String(b.device));
}

function normMac(value) {
  return String(value || "").toLowerCase().replace(/[^0-9a-f]/g, "");
}

function fmtMac(ctx, value) {
  const mac = normMac(value);
  if (!mac) return "";
  if (ctx.fmtMac) return ctx.fmtMac(mac);
  return mac.replace(/(.{2})(?=.)/g, "$1:");
}

function fmtUptime(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = Math.floor(n / 86400);
  const h = Math.floor((n % 86400) / 3600);
  const m = Math.floor((n % 3600) / 60);
  if (d > 0) return d + "d " + h + "h";
  if (h > 0) return h + "h " + m + "m";
  return m + "m";
}

function asText(value) {
  if (value == null || value === "") return "";
  return String(value);
}

function fmtMos(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  const scaled = n > 5 ? n / 100 : n;
  return (Math.round(scaled * 100) / 100).toFixed(2);
}

function num(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return String(Math.round(n * 10) / 10);
}

function numOrBlank(value) {
  if (value == null || value === "") return "";
  const n = Number(value);
  return Number.isFinite(n) ? n : "";
}

function stamp(ctx, value) {
  if (value == null || value === "") return "";
  try {
    if (ctx.fmtTime) return ctx.fmtTime(value);
  } catch (err) {
    void err;
  }
  return String(value);
}

function paint(ctx, model) {
  ensureStyle();
  const board = document.createElement("section");
  board.className = "bgp-board";
  board.dataset.bgpBoard = "1";
  board.setAttribute("aria-label", "BGP sessions");

  const head = document.createElement("div");
  head.className = "bgp-headbar";
  const titles = document.createElement("div");
  const kicker = document.createElement("p");
  kicker.className = "bgp-kicker";
  kicker.textContent = "BGP sessions";
  const title = document.createElement("h2");
  title.textContent = model.org || "Organization";
  const sub = document.createElement("p");
  sub.className = "bgp-subline";
  sub.textContent = model.scope + (model.failures.length ? " · some calls failed, see the log" : "");
  titles.append(kicker, title, sub);

  const tools = document.createElement("div");
  tools.className = "bgp-tools";
  const search = document.createElement("input");
  search.className = "bgp-search";
  search.type = "search";
  search.placeholder = "Filter site, device, neighbor, ASN";
  search.setAttribute("aria-label", "Filter");
  const fs = document.createElement("button");
  fs.type = "button";
  fs.className = "bgp-fs";
  fs.dataset.fs = "1";
  fs.textContent = "Full screen";
  tools.append(search, fs);
  head.append(titles, tools);

  const stats = document.createElement("div");
  stats.className = "bgp-stats";
  const chips = document.createElement("div");
  chips.className = "bgp-chips";
  const body = document.createElement("div");
  body.className = "bgp-body";

  board.append(head, stats, chips, body);

  const state = {
    q: "",
    view: "all",
    site: "all",
    alert: "",
  };

  function sites() {
    const names = new Set();
    for (const row of model.sessions) if (row.site) names.add(row.site);
    for (const row of model.paths) if (row.site) names.add(row.site);
    return [...names].sort();
  }

  function visibleSessions() {
    return model.sessions.filter((row) => {
      if (state.view === "path") return false;
      if (state.view === "switch" && row.roleKey !== "switch") return false;
      if (state.view === "wan" && row.roleKey !== "wan") return false;
      if (state.site !== "all" && row.site !== state.site) return false;
      if (state.alert === "down" || state.alert === "degraded") return false;
      if (state.alert === "fresh") return isFresh(row) && (!state.q || haySession(row).includes(state.q));
      return !state.q || haySession(row).includes(state.q);
    });
  }

  function visiblePaths() {
    return model.paths.filter((row) => {
      if (state.alert === "fresh") return false;
      if (state.view === "switch" || state.view === "wan") return false;
      if (state.site !== "all" && row.site !== state.site) return false;
      if (state.alert === "down" && row.tone !== "down") return false;
      if (state.alert === "degraded" && row.tone !== "warn") return false;
      return !state.q || hayPath(row).includes(state.q);
    });
  }

  function drawChrome() {
    const sessions = model.sessions;
    const paths = model.paths;
    const downN = paths.filter((row) => row.tone === "down").length;
    const degradedN = paths.filter((row) => row.tone === "warn").length;
    const freshN = sessions.filter(isFresh).length;
    stats.replaceChildren(
      statButton(String(sessions.filter((row) => row.tone === "up").length), "BGP up", "up", () => {
        state.view = "all";
        state.alert = "";
        draw();
      }),
      statButton(String(freshN), "BGP < 12h", freshN ? "warn" : "up", () => {
        state.view = "all";
        state.alert = state.alert === "fresh" ? "" : "fresh";
        draw();
      }),
      statButton(String(downN), "Paths down", downN ? "down" : "up", () => {
        state.view = "path";
        state.alert = state.alert === "down" ? "" : "down";
        draw();
      }),
      statButton(String(degradedN), "Paths degraded", degradedN ? "warn" : "up", () => {
        state.view = "path";
        state.alert = state.alert === "degraded" ? "" : "degraded";
        draw();
      }),
    );
    const views = [
      ["all", "All"],
      ["switch", "Switches"],
      ["wan", "WAN edge"],
      ["path", "Peer paths"],
    ];
    chips.replaceChildren();
    for (const [id, label] of views) {
      chips.append(chip(label, state.view === id && !state.alert, () => {
        state.view = id;
        state.alert = "";
        draw();
      }));
    }
    chips.append(chip("Down · " + downN, state.alert === "down", () => {
      state.view = "path";
      state.alert = state.alert === "down" ? "" : "down";
      draw();
    }, "down"));
    chips.append(chip("Degraded · " + degradedN, state.alert === "degraded", () => {
      state.view = "path";
      state.alert = state.alert === "degraded" ? "" : "degraded";
      draw();
    }, "warn"));
    chips.append(chip("BGP < 12h · " + freshN, state.alert === "fresh", () => {
      state.view = "all";
      state.alert = state.alert === "fresh" ? "" : "fresh";
      draw();
    }, "warn"));
    const pick = document.createElement("select");
    pick.className = "bgp-pick";
    pick.setAttribute("aria-label", "Site");
    const names = sites();
    const allOpt = document.createElement("option");
    allOpt.value = "all";
    allOpt.textContent = "All sites (" + names.length + ")";
    pick.append(allOpt);
    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      pick.append(opt);
    }
    if ([...pick.options].some((opt) => opt.value === state.site)) pick.value = state.site;
    pick.addEventListener("change", () => {
      state.site = pick.value;
      draw();
    });
    chips.append(pick);
  }

  function draw() {
    const top = body.scrollTop;
    drawChrome();
    body.replaceChildren();
    const sessions = visibleSessions();
    const paths = visiblePaths();
    const names = new Set();
    for (const row of sessions) names.add(row.site || "Unknown");
    for (const row of paths) names.add(row.site || "Unknown");
    const groups = [...names].map((name) => ({
      name,
      sessions: sessions.filter((row) => (row.site || "Unknown") === name),
      paths: paths.filter((row) => (row.site || "Unknown") === name),
    }));
    groups.sort((a, b) => {
      const bad = (group) =>
        group.sessions.some((row) => row.tone !== "up") || group.paths.some((row) => row.tone !== "up") ? 0 : 1;
      return bad(a) - bad(b) || a.name.localeCompare(b.name);
    });
    if (!groups.length) {
      const empty = document.createElement("p");
      empty.className = "bgp-empty";
      empty.textContent = "Nothing in this filter.";
      body.append(empty);
      return;
    }
    for (const group of groups) body.append(siteBox(group));
    body.scrollTop = top;
  }

  search.addEventListener("input", () => {
    state.q = search.value.trim().toLowerCase();
    draw();
  });
  fs.addEventListener("click", () => {
    toggleFull(board, fs);
  });
  board.addEventListener("fullscreenchange", () => syncFs(board, fs));

  ctx.mount.replaceChildren(board);
  draw();
  requestAnimationFrame(() => syncFs(board, fs));
}

function statButton(value, label, tone, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "bgp-stat";
  const numEl = document.createElement("span");
  numEl.className = "bgp-stat-num bgp-tone-" + tone;
  numEl.textContent = value;
  const lab = document.createElement("span");
  lab.className = "bgp-stat-lab";
  lab.textContent = label;
  button.append(numEl, lab);
  button.addEventListener("click", onClick);
  return button;
}

function chip(label, on, onClick, tone) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "bgp-chip" + (on ? " is-on" : "") + (tone ? " bgp-alert-" + tone : "");
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function siteBox(group) {
  const bad =
    group.sessions.filter((row) => row.tone !== "up").length +
    group.paths.filter((row) => row.tone !== "up").length;
  const box = document.createElement("article");
  box.className = "bgp-site " + (bad ? "is-bad" : "is-good");
  const head = document.createElement("div");
  head.className = "bgp-site-head";
  const title = document.createElement("h3");
  title.textContent = group.name;
  const meta = document.createElement("span");
  const bits = [];
  if (group.sessions.length) bits.push(group.sessions.length + " sessions");
  if (group.paths.length) bits.push(group.paths.length + " paths");
  if (bad) bits.push(bad + " not up");
  meta.textContent = bits.join(" · ");
  head.append(title, meta);
  box.append(head);

  if (group.sessions.length) {
    const labels = document.createElement("div");
    labels.className = "bgp-sess bgp-sess-head";
    for (const label of ["State", "Role", "Device", "VRF", "Neighbor", "Kind", "Routes", "Uptime"]) {
      const span = document.createElement("span");
      span.textContent = label;
      labels.append(span);
    }
    box.append(labels);
    for (const row of group.sessions) box.append(sessionLine(row));
  }
  if (group.paths.length) {
    const paths = document.createElement("div");
    paths.className = "bgp-paths";
    for (const row of group.paths) paths.append(pathObject(row));
    box.append(paths);
  }
  return box;
}

function sessionLine(row) {
  const line = document.createElement("div");
  line.className = "bgp-sess";
  line.dataset.tone = row.tone;
  const routes = (row.rxRoutes === "" ? "0" : row.rxRoutes) + "/" + (row.txRoutes === "" ? "0" : row.txRoutes);
  const asText = row.localAs && row.neighborAs ? row.localAs + "→" + row.neighborAs : "";
  const neighbor = [row.neighbor, asText, row.neighborName].filter(Boolean).join(" ");
  line.title = [row.device, row.model, row.node, row.mac, row.vrf].filter(Boolean).join(" · ");
  line.append(
    pill(row.stateLabel, row.tone),
    cell(row.role === "Switch" ? "Switch" : row.role === "WAN edge" ? "WAN" : row.role, false),
    cell(row.device, false),
    cell(row.vrf, true),
    cell(neighbor, true),
    cell(row.overlay, false),
    cell(row.flaps ? routes + " ·" + row.flaps + "f" : routes, true),
    cell((row.uptimeLabel || "—") + (isFresh(row) ? " <12h" : ""), true),
  );
  return line;
}

function pathObject(row) {
  const line = document.createElement("div");
  line.className = "bgp-path";
  line.dataset.tone = row.tone;
  const kind = row.kind === "SSR peer path" ? "SSR" : row.kind === "SRX IPsec" ? "SRX" : row.kind;
  const bits = [];
  if (row.tone === "warn") bits.push("degraded");
  if (!row.up) bits.push("down");
  bits.push(kind);
  if (row.up && row.latency !== "") bits.push(row.latency + " ms");
  if (row.loss !== "") bits.push(row.loss + "% loss");
  if (row.mos !== "") bits.push("MOS " + row.mos);
  if (row.activeLabel) bits.push(row.activeLabel);
  if (row.uptimeLabel) bits.push(row.uptimeLabel);
  const note = bits.join(" · ");

  const left = document.createElement("div");
  left.className = "bgp-end";
  const dot = document.createElement("i");
  dot.className = "bgp-dot bgp-tone-" + row.tone + (row.tone === "down" ? " bgp-live" : "");
  const name = document.createElement("strong");
  name.textContent = row.device || "WAN edge";
  const iface = document.createElement("span");
  iface.className = "bgp-mono";
  iface.textContent = row.iface || "";
  left.append(dot, name, iface);

  const wire = document.createElement("div");
  wire.className = "bgp-wire bgp-tone-" + row.tone;
  const label = document.createElement("span");
  label.className = "bgp-note";
  label.textContent = note;
  wire.append(label);
  wire.title = note;

  const right = document.createElement("div");
  right.className = "bgp-end bgp-end-right";
  const peer = document.createElement("strong");
  peer.textContent = row.peer || "Peer";
  const peerIface = document.createElement("span");
  peerIface.className = "bgp-mono";
  peerIface.textContent = row.peerIface || "";
  const peerSite = document.createElement("span");
  peerSite.className = "bgp-dim";
  peerSite.textContent = row.peerSite || "";
  right.append(peer, peerIface, peerSite);

  line.append(left, wire, right);
  return line;
}

function cell(value, mono) {
  const div = document.createElement("div");
  div.className = "bgp-clip" + (mono ? " bgp-mono" : "");
  div.textContent = value == null || value === "" ? "—" : String(value);
  return div;
}

function pill(label, tone) {
  const span = document.createElement("span");
  span.className = "bgp-pill bgp-tone-" + tone;
  const dot = document.createElement("i");
  if (tone === "down") dot.className = "bgp-live";
  span.append(dot, document.createTextNode(label));
  return span;
}

function haySession(row) {
  return [row.site, row.device, row.model, row.mac, row.node, row.vrf, row.neighbor, row.neighborName, row.neighborAs, row.localAs, row.overlay, row.stateLabel, row.role]
    .join(" ")
    .toLowerCase();
}

function hayPath(row) {
  return [row.site, row.device, row.model, row.node, row.iface, row.peer, row.peerSite, row.peerIface, row.kind, row.upLabel]
    .join(" ")
    .toLowerCase();
}

function syncFs(board, button) {
  const on = document.fullscreenElement === board || board.classList.contains("bgp-fill");
  button.textContent = on ? "Exit full screen" : "Full screen";
}

function dockOf(board) {
  if (!board._dock) board._dock = { parent: board.parentNode, next: board.nextSibling };
  return board._dock;
}

function park(board) {
  const dock = board._dock;
  if (!dock || !dock.parent || board.parentNode === dock.parent) return;
  if (dock.next && dock.next.parentNode === dock.parent) dock.parent.insertBefore(board, dock.next);
  else dock.parent.appendChild(board);
}

function leaveFull(board, button) {
  board.classList.remove("bgp-fill");
  park(board);
  if (document.fullscreenElement === board && document.exitFullscreen) {
    document.exitFullscreen().then(
      () => button && syncFs(board, button),
      () => button && syncFs(board, button),
    );
  }
  if (button) syncFs(board, button);
}

function enterFull(board, button) {
  dockOf(board);
  document.body.appendChild(board);
  board.classList.add("bgp-fill");
  if (button) syncFs(board, button);
  if (!board.requestFullscreen) return;
  board.requestFullscreen().then(
    () => {
      board.dataset.fsWent = "1";
      if (button) syncFs(board, button);
    },
    () => button && syncFs(board, button),
  );
}

function toggleFull(board, button) {
  if (board.classList.contains("bgp-fill") || document.fullscreenElement === board) leaveFull(board, button);
  else enterFull(board, button);
}

function ensureStyle() {
  let style = document.getElementById("bgp-sessions-style");
  if (!style) {
    style = document.createElement("style");
    style.id = "bgp-sessions-style";
    document.head.append(style);
  }
  style.textContent = CSS;
  if (!document.documentElement.dataset.bgpEsc) {
    document.documentElement.dataset.bgpEsc = "1";
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const live = document.querySelector(".bgp-board.bgp-fill");
      if (!live || document.fullscreenElement === live) return;
      leaveFull(live, live.querySelector("[data-fs]"));
    });
    document.addEventListener("fullscreenchange", () => {
      document.querySelectorAll(".bgp-board").forEach((live) => {
        if (!document.fullscreenElement && live.dataset.fsWent === "1") {
          live.classList.remove("bgp-fill");
          park(live);
          delete live.dataset.fsWent;
        }
        const button = live.querySelector("[data-fs]");
        if (button) syncFs(live, button);
      });
    });
  }
}

const CSS = `
.bgp-board {
  --ink: #101614; --panel: #17211c; --line: #31463c; --fg: #e7f2eb; --muted: #93a89b;
  --up: #3dce8e; --up-dim: #143528; --warn: #e6b15c; --warn-dim: #3a2e16; --down: #f07178; --down-dim: #3c1d22;
  display: flex; flex-direction: column; height: auto; min-height: 0;
  margin-top: 12px; color: #e7f2eb; background: var(--ink);
  border: 1px solid var(--line); border-radius: 14px; overflow: visible;
  font-family: "IBM Plex Sans", ui-sans-serif, "Segoe UI", sans-serif;
  font-size: 12px; line-height: 1.35;
}
.bgp-board.bgp-fill, .bgp-board:fullscreen {
  position: fixed; inset: 0; z-index: 2147483646; width: 100vw; max-height: none;
  height: 100vh; height: 100dvh; margin: 0; border: 0; border-radius: 0; background: var(--ink);
  display: flex; flex-direction: column; overflow: hidden;
}
.bgp-headbar, .bgp-stats, .bgp-chips { flex: 0 0 auto; padding: 8px 10px 0; }
.bgp-headbar { display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; align-items: flex-end; }
.bgp-kicker { margin: 0; color: var(--up); font-size: 10px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
.bgp-headbar h2 { margin: 0; font-size: 16px; font-weight: 600; }
.bgp-subline { margin: 1px 0 0; color: var(--muted); font-size: 12px; }
.bgp-tools { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.bgp-search, .bgp-chip, .bgp-fs, .bgp-pick, .bgp-stat {
  min-height: 32px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); color: var(--fg);
  font: inherit;
}
.bgp-search { padding: 0 10px; min-width: min(100%, 240px); outline: none; }
.bgp-chip, .bgp-fs { padding: 0 10px; cursor: pointer; }
.bgp-fs { background: var(--up); color: var(--ink); border-color: var(--up); font-weight: 600; }
.bgp-chip.is-on { border-color: var(--up); background: #203029; }
.bgp-chip.bgp-alert-down { color: var(--down); }
.bgp-chip.bgp-alert-down.is-on { border-color: var(--down); background: var(--down-dim); color: var(--down); }
.bgp-chip.bgp-alert-warn { color: var(--warn); }
.bgp-chip.bgp-alert-warn.is-on { border-color: var(--warn); background: var(--warn-dim); color: var(--warn); }
.bgp-pick { max-width: min(100%, 320px); padding: 0 10px; }
.bgp-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.bgp-stat { text-align: left; padding: 4px 10px; cursor: pointer; display: flex; flex-direction: column; border-radius: 10px; }
.bgp-stat-num { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 18px; line-height: 1.1; }
.bgp-stat-lab { color: var(--muted); font-size: 11px; }
.bgp-tone-up { color: var(--up); }
.bgp-tone-warn { color: var(--warn); }
.bgp-tone-down { color: var(--down); }
.bgp-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding-bottom: 8px; }
.bgp-body { overflow: visible; border-top: 1px solid var(--line); padding: 8px; display: flex; flex-direction: column; gap: 8px; }
.bgp-board.bgp-fill .bgp-body, .bgp-board:fullscreen .bgp-body {
  flex: 1 1 auto; min-height: 0; overflow: auto;
}
.bgp-site { border: 1px solid var(--line); border-radius: 10px; background: var(--panel); overflow: hidden; }
.bgp-site.is-good { box-shadow: inset 3px 0 0 var(--up); }
.bgp-site.is-bad { box-shadow: inset 3px 0 0 var(--down); }
.bgp-site-head {
  display: flex; width: 100%; align-items: baseline; justify-content: space-between; gap: 8px;
  padding: 6px 10px; border-bottom: 1px solid var(--line); background: #121c18;
}
.bgp-site.is-good .bgp-site-head h3 { color: var(--up); }
.bgp-site.is-bad .bgp-site-head h3 { color: var(--down); }
.bgp-site-head h3 { margin: 0; min-width: 0; font-size: 13px; font-weight: 600; }
.bgp-site-head span, .bgp-dim { color: var(--muted); font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 11px; white-space: nowrap; }
.bgp-sess {
  display: grid; align-items: center; column-gap: 8px; height: 26px; min-width: 720px;
  padding: 0 8px; border-top: 1px solid #24352d; font-size: 12px; color: var(--fg);
  grid-template-columns: 108px 56px minmax(120px, 1.2fr) minmax(72px, 0.7fr) minmax(160px, 1.6fr) 72px 76px 64px;
}
.bgp-sess-head { height: 22px; border-top: 0; color: var(--muted); background: transparent; }
.bgp-sess[data-tone="up"] { color: var(--up); background: #10241b; }
.bgp-sess[data-tone="down"] { color: var(--down); background: #2a1518; box-shadow: inset 3px 0 0 var(--down); }
.bgp-sess[data-tone="warn"] { color: var(--warn); background: #2a2414; box-shadow: inset 3px 0 0 var(--warn); }
.bgp-sess .bgp-clip { color: inherit; }
.bgp-paths { border-top: 1px solid var(--line); padding: 2px 0 4px; }
.bgp-path {
  display: grid; grid-template-columns: minmax(140px, 220px) minmax(160px, 1fr) minmax(140px, 220px);
  align-items: center; column-gap: 8px; min-height: 26px; min-width: 640px; padding: 0 8px; font-size: 12px;
}
.bgp-path[data-tone="up"] { color: var(--up); }
.bgp-path[data-tone="down"] { color: var(--down); background: #2a1518; }
.bgp-path[data-tone="warn"] { color: var(--warn); background: #2a2414; }
.bgp-end { display: flex; align-items: center; gap: 6px; min-width: 0; white-space: nowrap; }
.bgp-end strong { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.bgp-end-right { justify-content: flex-end; }
.bgp-dot { width: 6px; height: 6px; border-radius: 99px; background: currentColor; display: inline-block; flex: none; }
.bgp-wire { position: relative; height: 2px; background: currentColor; }
.bgp-note {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  background: #121c18; padding: 0 4px; white-space: nowrap;
  font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 12px; color: inherit;
}
.bgp-clip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bgp-mono { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 11px; }
.bgp-pill {
  display: inline-flex; align-items: center; gap: 4px;
  border-radius: 999px; padding: 0 6px; font-size: 10px; font-weight: 600; line-height: 16px;
}
.bgp-pill.bgp-tone-up { background: var(--up-dim); }
.bgp-pill.bgp-tone-warn { background: var(--warn-dim); }
.bgp-pill.bgp-tone-down { background: var(--down-dim); }
.bgp-pill i { width: 6px; height: 6px; border-radius: 99px; background: currentColor; display: inline-block; }
.bgp-live { animation: bgp-pip 1.6s ease-in-out infinite; }
.bgp-empty { margin: 0; padding: 18px 14px; color: var(--muted); }
@keyframes bgp-pip { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { .bgp-live { animation: none; } }
@media (max-width: 720px) {
  .bgp-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
`;
