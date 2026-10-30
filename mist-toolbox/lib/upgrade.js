// Org device upgrades (POST/GET /orgs/{org_id}/devices/upgrade), shared by Switch
// Site Upgrade and AP Site Upgrade: the start-time rules, version order, the
// device and version reads, the status export and the upgrade log.
//
// Only reads live here. The changes (schedule, cancel) stay in each tool, so the
// install check and the reader of a tool both see what it sends.
//
// Mist's reply comes in two shapes and both are read: the one switch-site-upgrade.py
// reads (start_datetime, reboot_strategy, targets.devices[]) and the OpenAPI one
// (strategy, target_version, upgrades[].upgrade.{start_time, targets:{upgraded[]…}}).

const FINISHED = new Set(["success", "succeeded", "completed", "done", "failed", "error", "cancelled", "canceled"]);
const PENDING = new Set(["created", "queued", "scheduled", "pending"]);
const TAG_RANK = { stable: 0, beta: 1, alpha: 2 };

export const asList = (v) => (Array.isArray(v) ? v : Array.isArray(v?.results) ? v.results : []);

// ---- Start time -------------------------------------------------------------------------

const leadText = (ms) => (ms % 3600000 === 0
  ? `${ms / 3600000} hour${ms === 3600000 ? "" : "s"}`
  : `${Math.round(ms / 60000)} minutes`);

/**
 * start_datetime rules: ISO 8601, with a timezone, at least `minLeadMs` ahead
 * (the switch script's two hours by default). Returns the error, or "" when fine.
 */
export function checkStart(iso, nowMs = Date.now(), minLeadMs = 2 * 60 * 60 * 1000) {
  const s = String(iso || "").trim();
  if (!s) return "Choose a start date and time.";
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) return `Invalid start_datetime format: "${s}".`;
  if (!m[3]) return "start_datetime must include timezone (e.g., -07:00).";
  const tz = m[3].toUpperCase() === "Z" ? "Z" : m[3].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const t = Date.parse(`${m[1]}T${m[2]}${tz}`);
  if (Number.isNaN(t)) return `Invalid start_datetime format: "${s}".`;
  if (t < nowMs + minLeadMs) return `start_datetime must be at least ${leadText(minLeadMs)} ahead of current time.`;
  return "";
}

/** "2026-10-11T02:00" (a datetime-local value) + offset minutes east of UTC -> "2026-10-11T02:00:00-04:00". */
export function localIso(value, offsetMinutes) {
  const v = String(value || "").trim();
  const m = v.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?/);
  if (!m) return "";
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `${m[1]}T${m[2]}:${m[3] || "00"}${off}`;
}

/** The default start: `aheadMin` minutes from now (two and a half hours), rounded up to 15 minutes. */
export function defaultStart(nowMs = Date.now(), aheadMin = 150) {
  const step = 15 * 60 * 1000;
  return new Date(Math.ceil((nowMs + aheadMin * 60 * 1000) / step) * step);
}

/** A Date as a datetime-local value in the browser's own timezone. */
export function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---- Versions and devices -----------------------------------------------------------------

/** Version order comparing number runs as numbers: 23.4R2-S3 > 23.4R2 > 22.4R3-S2; 0.14.29633 > 0.14.29411. */
export function compareVersions(a, b) {
  const ta = String(a).match(/\d+|[A-Za-z]+/g) || [];
  const tb = String(b).match(/\d+|[A-Za-z]+/g) || [];
  for (let i = 0; i < Math.max(ta.length, tb.length); i += 1) {
    if (ta[i] === undefined) return -1;
    if (tb[i] === undefined) return 1;
    const na = /^\d+$/.test(ta[i]);
    const nb = /^\d+$/.test(tb[i]);
    if (na && nb) {
      const d = Number(ta[i]) - Number(tb[i]);
      if (d) return d;
    } else if (ta[i] !== tb[i]) {
      return ta[i] < tb[i] ? -1 : 1;
    }
  }
  return 0;
}

/** Stable first, then beta, alpha and untagged; newest first within each. */
export const byTagThenNewest = (a, b) => (TAG_RANK[a.tag] ?? 3) - (TAG_RANK[b.tag] ?? 3) || compareVersions(b.version, a.version);

/**
 * GET /orgs/{org}/devices/versions items -> { model: [{version, tag}] }, stable
 * first, then newest first, without duplicates. A response that leaves out
 * `model` is filed under the single model asked for.
 */
export function groupVersions(items, models) {
  const out = Object.fromEntries(models.map((m) => [m, []]));
  for (const it of Array.isArray(items) ? items : []) {
    const version = String(it?.version || "").trim();
    const model = it?.model || (models.length === 1 ? models[0] : "");
    if (!version || !(model in out)) continue;
    if (!out[model].some((v) => v.version === version)) out[model].push({ version, tag: String(it.tag || "") });
  }
  for (const list of Object.values(out)) list.sort(byTagThenNewest);
  return out;
}

/** Models in use: [{ model, count, sites: [names], versions: {version: count} }], by model. */
export function modelsFromDevices(devices, type = "switch") {
  const by = new Map();
  for (const d of devices) {
    if (!d || (d.type && d.type !== type) || !d.model) continue;
    const e = by.get(d.model) || { model: d.model, count: 0, sites: new Set(), versions: {} };
    e.count += 1;
    if (d.__site) e.sites.add(d.__site);
    const v = d.version || "unknown";
    e.versions[v] = (e.versions[v] || 0) + 1;
    by.set(d.model, e);
  }
  return [...by.values()].map((e) => ({ ...e, sites: [...e.sites].sort() }))
    .sort((a, b) => a.model.localeCompare(b.model));
}

/** Devices of one type at each site, fetched once per site. Returns { devices, failed }. */
export async function loadDevices(ctx, sites, type, cache = new Map()) {
  const failed = [];
  const todo = sites.filter((s) => !cache.has(s.id));
  let done = 0;
  await ctx.pool(ctx.POOL_LIMIT, todo.map((s) => async () => {
    try {
      const rows = await ctx.getAll(`/sites/${s.id}/stats/devices`, { type });
      cache.set(s.id, rows.filter((d) => !d.type || d.type === type)
        .map((d) => ({ ...d, __site: s.name || s.id, __siteId: s.id })));
    } catch (e) {
      failed.push({ site: s.name || s.id, error: e.message });
      ctx.log(`${s.name || s.id}: ${e.message}`, "err");
    } finally {
      ctx.progress(++done, todo.length, s.name || s.id);
    }
  }));
  return { devices: sites.flatMap((s) => cache.get(s.id) || []), failed };
}

/** The versions Mist offers for these models, in one call. {} when Mist offers none or errors. */
export async function loadVersions(ctx, type, models) {
  if (!models.length) return {};
  try {
    const items = asList(await ctx.mistGet(`/orgs/${ctx.orgId}/devices/versions`, { type, model: models.join(",") }));
    return groupVersions(items, models);
  } catch (e) {
    ctx.log(`Could not read the versions Mist offers (${e.message}); type them instead.`, "info");
    return {};
  }
}

// ---- Status ---------------------------------------------------------------------------------

const isoUtc = (ms) => new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
const epochMs = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? (Number(n) > 1e11 ? Number(n) : Number(n) * 1000) : null);

// The OpenAPI reply lists MACs by stage; a device's stage is the furthest list it is in.
const STAGES = ["failed", "upgraded", "rebooted", "reboot_in_progress", "downloaded", "downloading",
  "download_requested", "scheduled", "skipped"];

/** Each MAC in an OpenAPI `targets` object with its furthest stage, in first-seen order. */
export function targetStages(targets) {
  const out = new Map();
  for (const stage of STAGES) {
    for (const mac of Array.isArray(targets?.[stage]) ? targets[stage] : []) {
      if (!out.has(mac)) out.set(mac, stage);
    }
  }
  return out;
}

/**
 * upgrade_status.xlsx: one row per target device, site_name first, then every key
 * sorted. The script's reply lists devices (targets.devices[]); the OpenAPI one only
 * lists MACs by stage, so those rows carry the MAC, its name when known, and the stage.
 */
export function flattenStatus(status, siteNames, macNames = {}) {
  const rows = [];
  for (const up of status?.upgrades || []) {
    const siteUpgrade = up.upgrade || {};
    const common = {
      site_name: siteNames[up.site_id] || "Unknown",
      site_id: up.site_id,
      site_upgrade_status: siteUpgrade.status,
      site_upgrade_id: siteUpgrade.id,
    };
    const devices = siteUpgrade.targets?.devices;
    if (Array.isArray(devices)) {
      for (const dev of devices) {
        rows.push({
          ...dev, ...common,
          scheduled_time: status.start_datetime ?? "N/A",
          reboot_time: status.reboot_datetime ?? "N/A",
          download_strategy: status.download_strategy ?? "N/A",
          reboot_strategy: status.reboot_strategy ?? "N/A",
        });
      }
      continue;
    }
    const start = epochMs(siteUpgrade.start_time);
    for (const [mac, stage] of targetStages(siteUpgrade.targets)) {
      rows.push({
        ...common, mac, name: macNames[mac] || "", device_status: stage,
        scheduled_time: status.start_datetime ?? (start ? isoUtc(start) : "N/A"),
        strategy: status.strategy ?? status.reboot_strategy ?? "N/A",
        target_version: status.target_version ?? "N/A",
      });
    }
  }
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => k !== "site_name").sort();
  const columns = ["site_name", ...keys].map((k) => ({ header: k, key: k }));
  const text = (v) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return { columns, rows: rows.map((r) => Object.fromEntries(columns.map((c) => [c.key, text(r[c.key])]))) };
}

/**
 * The status columns that repeat the same upgrade-wide value on every row, or that
 * site_name already says. The .xlsx keeps them; the on-screen table drops them and
 * shows the upgrade-wide values once, above it, so it fits the page.
 */
export const STATUS_REPEATED = ["site_id", "site_upgrade_id", "scheduled_time", "reboot_time",
  "download_strategy", "reboot_strategy", "strategy", "target_version"];

export function screenStatusColumns(columns) {
  return columns.filter((c) => !STATUS_REPEATED.includes(c.key));
}

/** Pending, In progress or Finished, from a Mist upgrade status; "" when there is none. */
export function upgradePhase(status) {
  const s = String(status || "").toLowerCase();
  if (!s) return "";
  if (FINISHED.has(s)) return "Finished";
  if (PENDING.has(s)) return "Pending";
  return "In progress";
}

/** The whole upgrade's status: Mist's own, else worked out from its sites'. */
function overallStatus(data) {
  if (data?.status) return String(data.status);
  const sites = (data?.upgrades || []).map((u) => String(u.upgrade?.status || "").toLowerCase()).filter(Boolean);
  if (!sites.length) return "";
  if (sites.every((x) => FINISHED.has(x))) {
    if (sites.some((x) => x === "failed" || x === "error")) return "failed";
    return sites.every((x) => x === "cancelled" || x === "canceled") ? "cancelled" : "completed";
  }
  return sites.find((x) => !FINISHED.has(x) && !PENDING.has(x)) || sites.find((x) => PENDING.has(x)) || sites[0];
}

/** True when the upgrade, or every site in it, has already finished. */
export function isFinished(data) {
  const sites = (data?.upgrades || []).map((u) => String(u.upgrade?.status || "").toLowerCase()).filter(Boolean);
  return FINISHED.has(String(data?.status || "").toLowerCase()) || (sites.length > 0 && sites.every((s) => FINISHED.has(s)));
}

// ---- Upgrade log ------------------------------------------------------------------------------

/**
 * What an upgrade is for: "ap", "switch", or "" when the reply does not say. Mist's
 * list never says and the OpenAPI detail reply may not, so after device_type it goes
 * by the firmware: firmware_type "ap" or an AP build (0.14.29633) is an AP upgrade;
 * firmware_type "junos" or a Junos release (23.4R2-S3) is a switch upgrade.
 */
export function upgradeKind(data) {
  if (data?.device_type) return String(data.device_type);
  const types = (data?.versions || []).map((v) => String(v?.firmware_type || "").toLowerCase());
  if (types.includes("ap")) return "ap";
  if (types.includes("junos")) return "switch";
  const versions = [data?.target_version, ...(data?.versions || []).flatMap((v) => [v?.version, ...Object.values(v?.model_version || {})])]
    .filter(Boolean).map(String);
  if (versions.some((v) => /^\d+\.\d+R\d/i.test(v))) return "switch";
  if (versions.some((v) => /^v?0\.\d+\.\d+/.test(v))) return "ap";
  return "";
}

/** True unless the upgrade is known to be for another kind of device: unknown ones are kept. */
const isKind = (data, type) => {
  const kind = upgradeKind(data);
  return !kind || kind === type;
};

/**
 * One Upgrade log row from a list item ({id, site_upgrades}) and the upgrade read
 * by its ID (null when that read failed; `error` then says why).
 */
export function logRow(item, data, siteNames = {}, error = "") {
  const sites = data?.upgrades || [];
  const siteIds = [...new Set([...(item?.site_upgrades || []).map((x) => x.site_id), ...sites.map((u) => u.site_id)].filter(Boolean))];
  const siteUpgradeIds = [...new Set([...(item?.site_upgrades || []).map((x) => x.upgrade_id),
    ...sites.map((u) => u.upgrade?.id)].filter(Boolean))];
  const iso = data?.start_datetime ? Date.parse(data.start_datetime) : NaN;
  const siteStarts = sites.map((u) => epochMs(u.upgrade?.start_time)).filter(Boolean);
  const startMs = Number.isFinite(iso) ? iso : siteStarts.length ? Math.min(...siteStarts) : null;
  const rebootMs = epochMs(sites.map((u) => u.upgrade?.reboot_at).find(Boolean));
  const count = (key, devStatus) => sites.reduce((n, u) => {
    const t = u.upgrade?.targets || {};
    if (Array.isArray(t[key])) return n + t[key].length;
    return n + (t.devices || []).filter((d) => devStatus.test(String(d.status || ""))).length;
  }, 0);
  const versions = (data?.versions || []).flatMap((v) => Object.entries(v?.model_version || {}))
    .concat(Object.entries(data?.model_version || {}))
    .map(([m, v]) => `${m} → ${v}`)
    .concat((data?.versions || []).filter((v) => v?.version && !Object.keys(v.model_version || {}).length).map((v) => v.version));
  const status = data ? overallStatus(data) : "";
  return {
    upgrade_id: item?.id || data?.id || "",
    phase: error ? "Unknown" : upgradePhase(status) || "Unknown",
    status: error ? `could not read: ${error}` : status,
    start: data?.start_datetime || (startMs ? isoUtc(startMs) : ""),
    startMs,
    reboot: data?.reboot_datetime || (rebootMs ? isoUtc(rebootMs) : ""),
    reboot_strategy: data?.reboot_strategy || data?.strategy || "",
    download_strategy: data?.download_strategy || "",
    versions: (versions.length ? versions : data?.target_version ? [data.target_version] : []).join(", "),
    site_count: siteIds.length,
    site_names: siteIds.map((id) => siteNames[id] || id).join(", "),
    devices: sites.reduce((n, u) => n + (Number(u.upgrade?.targets?.total) || (u.upgrade?.targets?.devices || []).length), 0),
    upgraded: count("upgraded", /^(upgraded|success|succeeded|completed|done)$/i),
    failed: count("failed", /^(failed|error)$/i),
    skipped: count("skipped", /^skipped$/i),
    site_upgrade_ids: siteUpgradeIds.join(", "),
  };
}

/** Newest start first; upgrades with no known start last, in Mist's order. */
export function sortLog(rows) {
  return rows.map((r, i) => ({ r, i }))
    .sort((a, b) => (b.r.startMs ?? -Infinity) - (a.r.startMs ?? -Infinity) || a.i - b.i)
    .map(({ r }) => r);
}

/** The log's .xlsx columns; `devices` names the count column ("Switches", "APs"). */
export function logColumns(devices) {
  return [
    { header: "Upgrade ID", key: "upgrade_id", width: 38 }, { header: "Phase", key: "phase", width: 12 },
    { header: "Status", key: "status", width: 14 }, { header: "Start", key: "start", width: 26 },
    { header: "Reboot", key: "reboot", width: 26 }, { header: "Reboot Strategy", key: "reboot_strategy", width: 15 },
    { header: "Download Strategy", key: "download_strategy", width: 17 }, { header: "Versions", key: "versions", width: 40, wrap: true },
    { header: "Sites", key: "site_count", width: 8 }, { header: "Site Names", key: "site_names", width: 40, wrap: true },
    { header: devices, key: "devices", width: 10 }, { header: "Upgraded", key: "upgraded", width: 10 },
    { header: "Failed", key: "failed", width: 8 }, { header: "Skipped", key: "skipped", width: 9 },
    { header: "Site Upgrade IDs", key: "site_upgrade_ids", width: 40, wrap: true },
  ];
}

/**
 * The org's upgrades of one device type, newest first when Mist says when they were
 * made. An item that names another device type is dropped; the list usually names none.
 */
export async function listUpgrades(ctx, type) {
  return asList(await ctx.mistGet(`/orgs/${ctx.orgId}/devices/upgrade`))
    .filter((u) => u && u.id && isKind(u, type))
    .map((u, i) => ({ ...u, __i: i }))
    .sort((a, b) => (Number(b.created_time) || 0) - (Number(a.created_time) || 0) || a.__i - b.__i);
}

export async function readUpgrade(ctx, id) {
  const data = await ctx.mistGet(`/orgs/${ctx.orgId}/devices/upgrade/${encodeURIComponent(id)}`);
  if (!data) throw new Error(`Upgrade ${id} was not found in this org.`);
  return data;
}

/**
 * Every upgrade of one device type in the org, each read for its detail (pooled), so
 * the log has status and timing. Returns { rows, failed }. An upgrade whose kind
 * cannot be told is kept; one that could not be read is kept with its ID.
 */
export async function loadUpgradeLog(ctx, siteNames = {}, type = "switch") {
  const list = await listUpgrades(ctx, type);
  const rows = new Array(list.length);
  let failed = 0;
  let done = 0;
  await ctx.pool(ctx.POOL_LIMIT, list.map((item, i) => async () => {
    try {
      const data = await readUpgrade(ctx, item.id);
      rows[i] = isKind(data, type) ? logRow(item, data, siteNames) : null;
    } catch (e) {
      failed++;
      rows[i] = logRow(item, null, siteNames, e.message);
      ctx.log(`Upgrade ${item.id}: ${e.message}`, "err");
    } finally {
      ctx.progress(++done, list.length, item.id);
    }
  }));
  return { rows: sortLog(rows.filter(Boolean)), failed };
}
