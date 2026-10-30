#!/usr/bin/env node
/**
 * Juniper Mist (GC2 cloud) - switch inventory + software versions -> Excel.
 *
 * Steps:
 *   1. Prompt for the API token (hidden input, never echoed or stored).
 *   2. Self check (GET /api/v1/self) to discover which org(s) the token can see.
 *   3. List every site in the selected org.
 *   4. For each site, pull switch stats (name, model, serial, version, status...).
 *   5. Write everything to a single-sheet .xlsx workbook.
 *
 * Requirements:  Node.js 18+  and  npm install exceljs
 */

"use strict";

const readline = require("readline");
const ExcelJS = require("exceljs");

// Mist "Global 04" cloud (GC2).  Change here if you ever need another region.
const MIST_API = "https://api.gc2.mist.com/api/v1";

const PAGE_LIMIT = 1000;
const MAX_RETRIES = 5;

// --------------------------------------------------------------------------- //
// Console input
// --------------------------------------------------------------------------- //
/** getpass equivalent: read a line from the terminal without echoing it. */
function promptHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);

    if (!stdin.isTTY) {
      // Piped input - no way to hide it, just read a line.
      const rl = readline.createInterface({ input: stdin });
      rl.once("line", (line) => {
        rl.close();
        resolve(line.trim());
      });
      return;
    }

    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        } else if (ch === "\u0003") {
          // Ctrl+C
          stdin.setRawMode(false);
          process.stdout.write("\n");
          console.error("Cancelled.");
          process.exit(1);
        } else if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    })
  );
}

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------- //
// API helpers
// --------------------------------------------------------------------------- //
function makeClient(token) {
  const headers = { Authorization: `Token ${token}`, Accept: "application/json" };

  /** GET with basic retry/backoff for 429 rate limits and transient 5xx. */
  async function get(path, params = {}) {
    const url = new URL(MIST_API + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });

      if (resp.status === 429 || resp.status >= 500) {
        const wait = Number(resp.headers.get("retry-after")) || 2 ** attempt;
        console.log(`    ${resp.status} on ${path}, retrying in ${wait}s (${attempt}/${MAX_RETRIES})...`);
        await sleep(wait * 1000);
        continue;
      }
      if (resp.status === 401) {
        fail(`401 Unauthorized - API token is invalid or expired for ${MIST_API}.`);
      }
      if (!resp.ok) {
        const err = new Error(`${resp.status} ${resp.statusText} for ${path}`);
        err.status = resp.status;
        throw err;
      }
      return resp.json();
    }
    throw new Error(`Gave up on ${path} after ${MAX_RETRIES} retries`);
  }

  /** Follow Mist page/limit pagination and return the combined list. */
  async function getAll(path, params = {}) {
    const results = [];
    for (let page = 1; ; page++) {
      const batch = await get(path, { ...params, limit: PAGE_LIMIT, page });
      if (!Array.isArray(batch) || batch.length === 0) break;
      results.push(...batch);
      if (batch.length < PAGE_LIMIT) break;
    }
    return results;
  }

  return { get, getAll };
}

// --------------------------------------------------------------------------- //
// Discovery
// --------------------------------------------------------------------------- //
async function selfCheck(api) {
  const me = await api.get("/self");
  const who = me.email || me.name || "API token";

  const orgs = new Map();
  for (const priv of me.privileges || []) {
    if (!priv.org_id) continue;
    // Prefer the org-scope entry for the name/role; site-scope entries
    // still tell us the org exists.
    if (priv.scope === "org" || !orgs.has(priv.org_id)) {
      orgs.set(priv.org_id, {
        orgId: priv.org_id,
        name: priv.org_name || priv.name || priv.org_id,
        role: priv.role || "",
      });
    }
  }
  return { who, orgs: [...orgs.values()] };
}

async function chooseOrg(orgs) {
  if (orgs.length === 0) {
    const orgId = await prompt("No orgs found in token privileges. Enter Org ID manually: ");
    if (!orgId) fail("No org selected.");
    return { orgId, name: orgId, role: "" };
  }
  if (orgs.length === 1) return orgs[0];

  console.log("\nThis token has access to multiple orgs:");
  orgs.forEach((o, i) => console.log(`  ${i + 1}) ${o.name}  [${o.orgId}]  role=${o.role}`));
  for (;;) {
    const choice = Number(await prompt(`Select org [1-${orgs.length}]: `));
    if (Number.isInteger(choice) && choice >= 1 && choice <= orgs.length) return orgs[choice - 1];
    console.log("Invalid choice.");
  }
}

async function getOrgName(api, org) {
  try {
    const info = await api.get(`/orgs/${org.orgId}`);
    return info.name || org.name;
  } catch {
    return org.name;
  }
}

// --------------------------------------------------------------------------- //
// Switch parsing
// --------------------------------------------------------------------------- //
function formatUptime(seconds) {
  if (!seconds) return "";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

function formatEpoch(epoch) {
  if (!epoch) return "";
  const dt = new Date(epoch * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ` +
         `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

/** Virtual Chassis members, e.g. "fpc0 XX123 (23.4R2-S3); fpc1 XX456 (23.4R2-S3)". */
function vcMembers(sw) {
  const mods = (sw.module_stat || []).filter((m) => m.serial);
  if (mods.length < 2) return { count: mods.length || 1, detail: "" };
  const detail = mods
    .map((m, i) => {
      const idx = m.fpc_idx ?? m._idx ?? i;
      const role = m.vc_role ? ` ${m.vc_role}` : "";
      return `fpc${idx}${role} ${m.serial} (${m.version || "?"})`;
    })
    .join("; ");
  return { count: mods.length, detail };
}

function switchRow(site, sw) {
  const vc = vcMembers(sw);
  return {
    site: site.name || site.id,
    name: sw.name || sw.hostname || "",
    model: sw.model || "",
    serial: sw.serial || "",
    mac: sw.mac || "",
    version: sw.version || "",
    status: sw.status || "",
    ip: sw.ip || (sw.ip_stat && sw.ip_stat.ip) || "",
    uptime: formatUptime(sw.uptime),
    lastSeen: formatEpoch(sw.last_seen),
    vcCount: vc.count,
    vcDetail: vc.detail,
    siteId: site.id,
    deviceId: sw.id || "",
  };
}

// --------------------------------------------------------------------------- //
// Excel output
// --------------------------------------------------------------------------- //
async function writeWorkbook(rows, fileName) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Switches", { views: [{ state: "frozen", ySplit: 1 }] });

  ws.columns = [
    { header: "Site", key: "site" },
    { header: "Switch Name", key: "name" },
    { header: "Model", key: "model" },
    { header: "Serial", key: "serial" },
    { header: "MAC", key: "mac" },
    { header: "Software Version", key: "version" },
    { header: "Status", key: "status" },
    { header: "IP", key: "ip" },
    { header: "Uptime", key: "uptime" },
    { header: "Last Seen", key: "lastSeen" },
    { header: "VC Members", key: "vcCount" },
    { header: "VC Member Versions", key: "vcDetail" },
    { header: "Site ID", key: "siteId" },
    { header: "Device ID", key: "deviceId" },
  ];
  ws.addRows(rows);

  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };

  ws.columns.forEach((col) => {
    let width = 0;
    col.eachCell({ includeEmpty: false }, (cell) => {
      width = Math.max(width, String(cell.value ?? "").length);
    });
    col.width = Math.min(Math.max(width + 2, 10), 60);
  });

  await wb.xlsx.writeFile(fileName);
}

// --------------------------------------------------------------------------- //
// Main
// --------------------------------------------------------------------------- //
async function main() {
  console.log(`Juniper Mist switch report  (${MIST_API})`);
  const token = await promptHidden("Mist API token: ");
  if (!token) fail("No token entered.");

  const api = makeClient(token);

  console.log("Running self check...");
  const { who, orgs } = await selfCheck(api);
  console.log(`  Authenticated as: ${who}`);
  const org = await chooseOrg(orgs);
  const orgName = await getOrgName(api, org);
  console.log(`  Org: ${orgName}  [${org.orgId}]`);

  console.log("Fetching sites...");
  const sites = (await api.getAll(`/orgs/${org.orgId}/sites`)).sort((a, b) =>
    (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" })
  );
  console.log(`  Found ${sites.length} site(s)`);

  const rows = [];
  const errors = [];
  for (const [i, site] of sites.entries()) {
    const name = site.name || site.id;
    try {
      const switches = await api.getAll(`/sites/${site.id}/stats/devices`, { type: "switch" });
      console.log(`  [${i + 1}/${sites.length}] ${name}: ${switches.length} switch(es)`);
      switches
        .sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }))
        .forEach((sw) => rows.push(switchRow(site, sw)));
    } catch (e) {
      console.log(`  [${i + 1}/${sites.length}] ${name}: ! failed: ${e.message}`);
      errors.push(name);
    }
  }

  const ts = new Date().toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
  const safeOrg = orgName.replace(/[^A-Za-z0-9_-]/g, "_");
  const fileName = `mist_switches_${safeOrg}_${ts}.xlsx`;
  await writeWorkbook(rows, fileName);

  const versions = new Set(rows.map((r) => r.version).filter(Boolean));
  console.log(`\nDone. ${rows.length} switch(es) across ${sites.length} site(s), ` +
              `${versions.size} distinct software version(s).`);
  if (errors.length) console.log(`${errors.length} site(s) had errors: ${errors.join(", ")}`);
  console.log(`Saved: ${fileName}`);
}

main().catch((e) => fail(e.message));
