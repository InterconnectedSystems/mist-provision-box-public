// AP Site Upgrade, modelled on Switch Site Upgrade: one version for every chosen
// model from Mist's list, the strategy settings the spec defines, the 15-minute
// rule, and that nothing is sent for a token that cannot make changes or an
// upgrade that already finished. The screen is exercised in headless Chromium;
// this covers its logic.

import { strict as assert } from "node:assert";
import test from "node:test";

import tool, {
  DEFAULT_OPTIONS, MIN_LEAD_MS, buildPayload, cancelUpgrade, checkOptions, commonVersions, loadAps,
  loadUpgradeLog, loadVersions, modelsFromAps, parsePhases, planRows, scheduleUpgrade,
} from "../tools/ap-site-upgrade.js";
import { checkStart } from "../lib/upgrade.js";
import { stubMist, testCtx } from "./helpers.mjs";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const LATER = "2099-01-01T02:00:00-05:00";
const SITES = [{ id: "s1", name: "HQ" }, { id: "s2", name: "Branch" }, { id: "s3", name: "Lab" }];
const ap = (o) => ({ type: "ap", status: "connected", ...o });
const APS = {
  "/sites/s1/stats/devices": [
    ap({ name: "hq-ap-1", mac: "5c5b35000001", model: "AP45", version: "0.14.29411" }),
    ap({ name: "hq-ap-2", mac: "5c5b35000002", model: "AP45", version: "0.14.29633" }),
    ap({ name: "hq-ap-3", mac: "5c5b35000003", model: "AP34", version: "0.12.27139" }),
  ],
  "/sites/s2/stats/devices": [ap({ name: "br-ap-1", mac: "5c5b35000004", model: "AP34", version: "0.14.29411" })],
};
const tagged = (o) => Object.entries(o).map(([version, tag]) => ({ version, tag }));

test("the tool draws its own screen and declares that it makes changes", () => {
  assert.equal(typeof tool.mount, "function");
  assert.equal(tool.id, "ap-site-upgrade");
  assert.equal(tool.writes, true);
  assert.equal(tool.scope, undefined, "no generated site picker: the screen has its own checklist");
  assert.equal(tool.params, undefined);
  assert.equal(tool.level, "Site · Org");
});

// ---- versions -------------------------------------------------------------------

test("one call to the org versions endpoint, type=ap, every model comma-separated", async () => {
  const calls = stubMist({ "/orgs/org-1/devices/versions": [
    { model: "AP45", version: "0.14.29633", tag: "stable" },
    { model: "AP34", version: "0.14.29633", tag: "stable" },
  ] });
  const v = await loadVersions(testCtx(), ["AP45", "AP34"]);
  const asked = calls.filter((c) => c.includes("/devices/versions"));
  assert.equal(asked.length, 1);
  const q = new URLSearchParams(asked[0].split("?")[1]);
  assert.equal(q.get("type"), "ap");
  assert.equal(q.get("model"), "AP45,AP34");
  assert.deepEqual(v.AP34, [{ version: "0.14.29633", tag: "stable" }]);
});

test("the version list is what Mist offers for every chosen model, stable first, newest first", () => {
  const byModel = {
    AP45: tagged({ "0.14.29633": "stable", "0.14.29411": "stable", "0.15.30001": "beta" }),
    AP34: tagged({ "0.15.30001": "beta", "0.14.29411": "stable", "0.12.27139": "stable" }),
    AP12: [],
  };
  assert.deepEqual(commonVersions(byModel, ["AP45", "AP34"]).map((v) => `${v.version}:${v.tag}`),
    ["0.14.29411:stable", "0.15.30001:beta"]);
  assert.deepEqual(commonVersions(byModel, ["AP45"]).map((v) => v.version), ["0.14.29633", "0.14.29411", "0.15.30001"]);
  assert.deepEqual(commonVersions(byModel, ["AP45", "AP12"]), [], "a model with no list means a typed version");
  assert.deepEqual(commonVersions(byModel, []), []);
});

// ---- sites, APs, models -------------------------------------------------------------

test("APs are read once per site; a failing site is reported, not fatal", async () => {
  const calls = stubMist({ ...APS, "/sites/s3/stats/devices": () => { throw new Error("nope"); } });
  const cache = new Map();
  const first = await loadAps(testCtx(), SITES, cache);
  assert.equal(first.aps.length, 4);
  assert.deepEqual(first.failed.map((f) => f.site), ["Lab"]);
  assert.ok(calls.some((c) => c.startsWith("/sites/s1/stats/devices") && c.includes("type=ap")));
  const before = calls.length;
  const again = await loadAps(testCtx(), SITES.slice(0, 2), cache);
  assert.equal(again.aps.length, 4);
  assert.equal(calls.length, before, "cached sites are not read again");
});

const ALL = [...APS["/sites/s1/stats/devices"].map((d) => ({ ...d, __site: "HQ", __siteId: "s1" })),
  ...APS["/sites/s2/stats/devices"].map((d) => ({ ...d, __site: "Branch", __siteId: "s2" }))];

test("models carry their AP count, sites and current versions", () => {
  assert.deepEqual(modelsFromAps([...ALL, { type: "switch", model: "EX4100-48P" }]), [
    { model: "AP34", count: 2, sites: ["Branch", "HQ"], versions: { "0.12.27139": 1, "0.14.29411": 1 } },
    { model: "AP45", count: 2, sites: ["HQ"], versions: { "0.14.29411": 1, "0.14.29633": 1 } },
  ]);
});

test("plan rows: the chosen models only; without force, APs at or above the target are marked skipped", () => {
  const rows = planRows(ALL, ["AP45", "AP34"], "0.14.29411");
  assert.deepEqual(rows.map((r) => [r.site, r.name, r.current, r.note]), [
    ["Branch", "br-ap-1", "0.14.29411", "Skipped: already on this version"],
    ["HQ", "hq-ap-1", "0.14.29411", "Skipped: already on this version"],
    ["HQ", "hq-ap-2", "0.14.29633", "Skipped: newer than the target"],
    ["HQ", "hq-ap-3", "0.12.27139", ""],
  ]);
  assert.ok(planRows(ALL, ["AP45", "AP34"], "0.14.29411", true).every((r) => !r.note), "force upgrades them all");
  assert.deepEqual(planRows(ALL, ["AP34"], "0.14.29633").map((r) => r.name), ["br-ap-1", "hq-ap-3"]);
});

// ---- strategy and start time ----------------------------------------------------------

test("strategy settings are checked", () => {
  assert.deepEqual(checkOptions("big_bang", { ...DEFAULT_OPTIONS, maxFailurePct: "x" }), [], "big_bang has no failure limit");
  assert.deepEqual(checkOptions("serial", DEFAULT_OPTIONS), []);
  assert.match(checkOptions("serial", { ...DEFAULT_OPTIONS, maxFailurePct: "101" })[0], /0 to 100/);
  assert.deepEqual(checkOptions("canary", DEFAULT_OPTIONS), []);
  for (const bad of ["1, 50, 10, 100", "10, 50", "0, 100", "a, 100", ""]) {
    assert.match(checkOptions("canary", { ...DEFAULT_OPTIONS, canaryPhases: bad })[0], /end at 100/, bad);
  }
  assert.deepEqual(checkOptions("rrm", { ...DEFAULT_OPTIONS, rrmFirstBatchPct: "2", rrmMaxBatchPct: "10" }), []);
  assert.match(checkOptions("rrm", { ...DEFAULT_OPTIONS, rrmFirstBatchPct: "20", rrmMaxBatchPct: "10" })[0], /cannot be larger/);
  assert.match(checkOptions("rrm", { ...DEFAULT_OPTIONS, rrmMaxBatchPct: "0" })[0], /1 to 100/);
  assert.match(checkOptions("rolling", DEFAULT_OPTIONS)[0], /Unknown strategy/);
  assert.deepEqual(parsePhases("1,10 50, 100"), [1, 10, 50, 100]);
});

test("start time: at least 15 minutes ahead", () => {
  assert.equal(MIN_LEAD_MS, 15 * 60 * 1000);
  assert.equal(checkStart("2026-10-10T12:20:00Z", NOW, MIN_LEAD_MS), "");
  assert.equal(checkStart("2026-10-10T12:10:00Z", NOW, MIN_LEAD_MS),
    "start_datetime must be at least 15 minutes ahead of current time.");
  assert.match(checkStart("2026-10-10T13:00:00", NOW, MIN_LEAD_MS), /must include timezone/);
});

// ---- the request ------------------------------------------------------------------------

const BASE = { siteIds: ["s1", "s2"], models: ["AP45", "AP34"], version: "0.14.29633", startDatetime: LATER };
const COMMON = {
  device_type: "ap",
  versions: [{ firmware_type: "ap", version: "0.14.29633", force: false }],
  all_sites: false, site_ids: ["s1", "s2"], models: ["AP45", "AP34"], start_datetime: LATER,
};

test("payload, big_bang: no failure limit, no strategy extras", () => {
  assert.deepEqual(buildPayload({ ...BASE, strategy: "big_bang" }), { ...COMMON, strategy: "big_bang" });
  assert.equal(buildPayload({ ...BASE, force: true, strategy: "big_bang" }).versions[0].force, true);
});

test("payload, serial and canary: the failure limit, and canary's phases", () => {
  assert.deepEqual(buildPayload({ ...BASE, strategy: "serial" }),
    { ...COMMON, strategy: "serial", max_failure_percentage: 5 });
  assert.deepEqual(buildPayload({ ...BASE, strategy: "canary", opts: { ...DEFAULT_OPTIONS, maxFailurePct: "10", canaryPhases: "5, 25, 100" } }),
    { ...COMMON, strategy: "canary", max_failure_percentage: 10, canary_phases: [5, 25, 100] });
});

test("payload, rrm: node order, mesh and slow ramp always; batch sizes only when given", () => {
  assert.deepEqual(buildPayload({ ...BASE, strategy: "rrm" }), {
    ...COMMON, strategy: "rrm", max_failure_percentage: 5,
    rrm_node_order: "fringe_to_center", rrm_mesh_upgrade: "sequential", rrm_slow_ramp: false,
  });
  const opts = { ...DEFAULT_OPTIONS, rrmNodeOrder: "center_to_fringe", rrmMeshUpgrade: "parallel",
    rrmFirstBatchPct: "2", rrmMaxBatchPct: "10", rrmSlowRamp: true };
  assert.deepEqual(buildPayload({ ...BASE, strategy: "rrm", opts }), {
    ...COMMON, strategy: "rrm", max_failure_percentage: 5,
    rrm_node_order: "center_to_fringe", rrm_mesh_upgrade: "parallel",
    rrm_first_batch_percentage: 2, rrm_max_batch_percentage: 10, rrm_slow_ramp: true,
  });
});

// ---- schedule, cancel, log ----------------------------------------------------------------

const PAYLOAD = buildPayload({ ...BASE, strategy: "big_bang" });

test("scheduling sends one POST and returns Mist's upgrade id", async () => {
  stubMist({ "/orgs/org-1/devices/upgrade": { id: "up-new", site_upgrades: [{ site_id: "s1", upgrade_id: "su1" }] } });
  const ctx = testCtx({ role: "write" });
  const res = await scheduleUpgrade(ctx, PAYLOAD);
  assert.equal(res.id, "up-new");
  assert.deepEqual(ctx.writes, [{ method: "POST", path: "/orgs/org-1/devices/upgrade", body: PAYLOAD }]);
});

test("a read-only token stops before anything is sent", async () => {
  stubMist({ "/orgs/org-1/devices/upgrade": { id: "x" } });
  const ctx = testCtx({ role: "read" });
  await assert.rejects(scheduleUpgrade(ctx, PAYLOAD), /cannot make changes.*Nothing was sent/);
  assert.deepEqual(ctx.writes, []);
});

// The OpenAPI reply, which is what an AP upgrade returns.
const STATUS = { id: "up-2", strategy: "big_bang", target_version: "0.14.29633", upgrades: [
  { site_id: "s1", upgrade: { id: "su1", status: "upgrading", start_time: 1717658765,
    targets: { total: 3, upgraded: ["5c5b35000001"], downloading: ["5c5b35000002"], skipped: ["5c5b35000003"] } } },
] };

test("cancel: one POST to /cancel; nothing for a finished upgrade or a read-only token", async () => {
  stubMist({ "/orgs/org-1/devices/upgrade/up-2": STATUS });
  const ctx = testCtx({ role: "write" });
  assert.equal(await cancelUpgrade(ctx, "up-2"), "Cancelled upgrade up-2.");
  assert.deepEqual(ctx.writes, [{ method: "POST", path: "/orgs/org-1/devices/upgrade/up-2/cancel", body: undefined }]);

  stubMist({ "/orgs/org-1/devices/upgrade/up-2": { ...STATUS, upgrades: [{ site_id: "s1", upgrade: { status: "completed" } }] } });
  const done = testCtx({ role: "write" });
  assert.match(await cancelUpgrade(done, "up-2"), /nothing to cancel/);
  assert.deepEqual(done.writes, []);

  stubMist({ "/orgs/org-1/devices/upgrade/up-2": STATUS });
  const reader = testCtx({ role: "read" });
  await assert.rejects(cancelUpgrade(reader, "up-2"), /cannot make changes/);
  assert.deepEqual(reader.writes, []);
});

test("upgrade log: AP upgrades kept, switch upgrades dropped, unknown kept", async () => {
  stubMist({
    "/orgs/org-1/devices/upgrade": [{ id: "up-ap" }, { id: "up-sw" }, { id: "up-junos" }, { id: "up-typed" }, { id: "up-blank" }],
    "/orgs/org-1/devices/upgrade/up-ap": STATUS,
    "/orgs/org-1/devices/upgrade/up-sw": { device_type: "switch", status: "completed" },
    "/orgs/org-1/devices/upgrade/up-junos": { target_version: "23.4R2-S3", upgrades: [] },
    "/orgs/org-1/devices/upgrade/up-typed": { device_type: "ap", status: "scheduled", start_datetime: LATER },
    "/orgs/org-1/devices/upgrade/up-blank": { status: "completed" },
  });
  const { rows } = await loadUpgradeLog(testCtx(), { s1: "HQ" });
  assert.deepEqual(rows.map((r) => r.upgrade_id), ["up-typed", "up-ap", "up-blank"]);
  const r = rows[1];
  assert.deepEqual([r.phase, r.status, r.versions, r.reboot_strategy, r.site_names], ["In progress", "upgrading", "0.14.29633", "big_bang", "HQ"]);
  assert.deepEqual([r.devices, r.upgraded, r.failed, r.skipped], [3, 1, 0, 1]);
});
