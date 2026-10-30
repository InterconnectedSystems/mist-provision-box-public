// Switch Site Upgrade, ported from switch-site-upgrade.py: the version list from
// Mist, the script's checks and payload, its status export, and that nothing is
// sent for a token that cannot make changes or an upgrade that already finished.
// The screen itself is exercised in headless Chromium; this covers its logic.

import { strict as assert } from "node:assert";
import test from "node:test";

import tool, {
  buildPayload, cancelUpgrade, checkStart, compareVersions, defaultStart, familyMix, flattenStatus,
  groupVersions, isFinished, listUpgrades, loadSwitches, loadUpgradeLog, loadVersions, localIso, logRow, modelsFromDevices,
  planRows, scheduleUpgrade, screenStatusColumns, sortLog, toLocalInput, upgradePhase,
} from "../tools/switch-site-upgrade.js";
import { stubMist, testCtx } from "./helpers.mjs";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const LATER = "2099-01-01T02:00:00-05:00";
const SITES = [{ id: "s1", name: "HQ" }, { id: "s2", name: "Branch" }, { id: "s3", name: "Lab" }];
const sw = (o) => ({ type: "switch", status: "connected", ...o });
const SWITCHES = {
  "/sites/s1/stats/devices": [
    sw({ name: "hq-core", mac: "aabbcc000001", model: "QFX5120-48Y", version: "22.4R3" }),
    sw({ name: "hq-acc-1", mac: "aabbcc000002", model: "EX4100-48P", version: "22.4R3" }),
    sw({ name: "hq-acc-2", mac: "aabbcc000003", model: "EX4100-48P", version: "23.4R2-S3" }),
  ],
  "/sites/s2/stats/devices": [sw({ name: "br-1", mac: "aabbcc000004", model: "EX2300-24P", version: "21.4R3" })],
};

test("the tool draws its own screen and declares that it makes changes", () => {
  assert.equal(typeof tool.mount, "function");
  assert.equal(tool.writes, true);
  assert.equal(tool.scope, undefined, "no generated site picker: the screen has its own checklist");
  assert.equal(tool.params, undefined);
  assert.deepEqual(tool.level, "Site · Org");
});

// ---- versions -------------------------------------------------------------------

test("Junos versions compare by their number runs", () => {
  const sorted = ["22.4R3-S2", "23.4R2", "23.4R2-S3", "21.4R3-S10", "21.4R3-S9"].sort(compareVersions);
  assert.deepEqual(sorted, ["21.4R3-S9", "21.4R3-S10", "22.4R3-S2", "23.4R2", "23.4R2-S3"]);
});

test("versions are grouped per model, stable first, newest first, without duplicates", () => {
  const g = groupVersions([
    { model: "EX4100-48P", version: "24.2R1", tag: "beta" },
    { model: "EX4100-48P", version: "22.4R3-S2", tag: "stable" },
    { model: "EX4100-48P", version: "23.4R2-S3", tag: "stable" },
    { model: "EX4100-48P", version: "23.4R2-S3", tag: "stable" },
    { model: "EX2300-24P", version: "21.4R3-S5" },
    { model: "SOMETHING-ELSE", version: "1.0" },
  ], ["EX4100-48P", "EX2300-24P", "QFX5120-48Y"]);
  assert.deepEqual(g["EX4100-48P"].map((v) => `${v.version}:${v.tag}`),
    ["23.4R2-S3:stable", "22.4R3-S2:stable", "24.2R1:beta"]);
  assert.deepEqual(g["EX2300-24P"], [{ version: "21.4R3-S5", tag: "" }]);
  assert.deepEqual(g["QFX5120-48Y"], [], "a model Mist lists nothing for is empty, so the screen offers a text box");
  assert.deepEqual(groupVersions([{ version: "23.4R2-S3", tag: "stable" }], ["EX4100-48P"])["EX4100-48P"],
    [{ version: "23.4R2-S3", tag: "stable" }], "a reply without model is filed under the one model asked for");
});

test("one call to the org versions endpoint, every model comma-separated", async () => {
  const calls = stubMist({ "/orgs/org-1/devices/versions": [
    { model: "EX4100-48P", version: "23.4R2-S3", tag: "stable" },
    { model: "EX2300-24P", version: "21.4R3-S5", tag: "stable" },
  ] });
  const v = await loadVersions(testCtx(), ["EX4100-48P", "EX2300-24P"]);
  const asked = calls.filter((c) => c.includes("/devices/versions"));
  assert.equal(asked.length, 1);
  const q = new URLSearchParams(asked[0].split("?")[1]);
  assert.equal(asked[0].split("?")[0], "/orgs/org-1/devices/versions");
  assert.equal(q.get("type"), "switch");
  assert.equal(q.get("model"), "EX4100-48P,EX2300-24P");
  assert.deepEqual(v["EX2300-24P"], [{ version: "21.4R3-S5", tag: "stable" }]);
});

test("when Mist cannot list versions, nothing breaks: an empty list per model", async () => {
  stubMist({});
  assert.deepEqual(await loadVersions(testCtx(), ["EX4100-48P"]), { "EX4100-48P": [] });
  stubMist({ "/orgs/org-1/devices/versions": () => { throw new Error("boom"); } });
  assert.deepEqual(await loadVersions(testCtx(), ["EX4100-48P"]), {});
});

// ---- sites, switches, models -------------------------------------------------------

test("switches are read once per site; a failing site is reported, not fatal", async () => {
  const calls = stubMist({ ...SWITCHES, "/sites/s3/stats/devices": () => { throw new Error("nope"); } });
  const cache = new Map();
  const first = await loadSwitches(testCtx(), SITES, cache);
  assert.equal(first.switches.length, 4);
  assert.deepEqual(first.failed.map((f) => f.site), ["Lab"]);
  const before = calls.length;
  const again = await loadSwitches(testCtx(), SITES.slice(0, 2), cache);
  assert.equal(again.switches.length, 4);
  assert.equal(calls.length, before, "cached sites are not read again");
});

test("models carry their switch count, sites and current versions", () => {
  const all = [...SWITCHES["/sites/s1/stats/devices"].map((d) => ({ ...d, __site: "HQ", __siteId: "s1" })),
    ...SWITCHES["/sites/s2/stats/devices"].map((d) => ({ ...d, __site: "Branch", __siteId: "s2" }))];
  const models = modelsFromDevices(all);
  assert.deepEqual(models.find((m) => m.model === "EX4100-48P"),
    { model: "EX4100-48P", count: 2, sites: ["HQ"], versions: { "22.4R3": 1, "23.4R2-S3": 1 } });
  assert.deepEqual(planRows(all, { "EX4100-48P": "23.4R2-S3" }).map((r) => [r.site, r.name, r.current, r.target]),
    [["HQ", "hq-acc-1", "22.4R3", "23.4R2-S3"], ["HQ", "hq-acc-2", "23.4R2-S3", "23.4R2-S3"]]);
  assert.equal(familyMix(["EX4100-48P", "QFX5120-48Y"]), true);
  assert.equal(familyMix(["EX4100-48P", "EX2300-24P"]), false);
});

// ---- start time -------------------------------------------------------------------

test("start time: local picker value to ISO with offset, and the script's rules", () => {
  assert.equal(localIso("2026-10-11T02:00", -240), "2026-10-11T02:00:00-04:00");
  assert.equal(localIso("2026-10-11T02:00", 330), "2026-10-11T02:00:00+05:30");
  assert.equal(localIso("2026-10-11T02:00", 0), "2026-10-11T02:00:00+00:00");
  assert.equal(localIso("", 0), "");
  const d = defaultStart(NOW);
  assert.ok(d.getTime() - NOW >= 150 * 60 * 1000 && d.getTime() % (15 * 60 * 1000) === 0, d.toISOString());
  assert.match(toLocalInput(d), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal(checkStart("2026-10-09T15:00:00+00:00", NOW), "");
  assert.equal(checkStart("2026-10-09T13:30:00+00:00", NOW), "start_datetime must be at least 2 hours ahead of current time.");
  assert.equal(checkStart("2026-10-09T15:00:00", NOW), "start_datetime must include timezone (e.g., -07:00).");
  assert.match(checkStart("", NOW), /Choose a start/);
});

// ---- schedule, status, cancel --------------------------------------------------------

const PAYLOAD = buildPayload({ siteIds: ["s1"], modelVersion: { "EX4100-48P": "23.4R2-S3" },
  startDatetime: LATER, rebootStrategy: "big_bang" });

test("the payload is the script's", () => {
  assert.deepEqual(PAYLOAD, {
    device_type: "switch",
    versions: [{ firmware_type: "junos", model_version: { "EX4100-48P": "23.4R2-S3" } }],
    all_sites: false, site_ids: ["s1"], models: ["EX4100-48P"], start_datetime: LATER,
    download_strategy: "big_bang", reboot_strategy: "big_bang",
  });
});

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

const STATUS = {
  id: "up-2", status: "scheduled", start_datetime: LATER, reboot_strategy: "serial",
  upgrades: [{ site_id: "s1", upgrade: { id: "su1", status: "scheduled", targets: { devices: [{ mac: "aabbcc000002", extra: { a: 1 } }] } } }],
};

test("recent upgrades: switch upgrades only, newest first", async () => {
  stubMist({ "/orgs/org-1/devices/upgrade": [
    { id: "up-1", device_type: "switch", created_time: 100 },
    { id: "up-2", device_type: "switch", created_time: 200 },
    { id: "up-ap", device_type: "ap", created_time: 300 },
  ] });
  assert.deepEqual((await listUpgrades(testCtx())).map((u) => u.id), ["up-2", "up-1"]);
});

test("status export: site_name first, then every other field sorted", () => {
  const { columns, rows } = flattenStatus(STATUS, { s1: "HQ" });
  assert.deepEqual(columns.map((c) => c.key), ["site_name", "download_strategy", "extra", "mac", "reboot_strategy",
    "reboot_time", "scheduled_time", "site_id", "site_upgrade_id", "site_upgrade_status"]);
  assert.equal(rows[0].site_name, "HQ");
  assert.equal(rows[0].reboot_time, "N/A");
  assert.equal(rows[0].extra, '{"a":1}');
});

test("status on screen: drops the upgrade-wide columns the .xlsx keeps, so the table fits", () => {
  const { columns } = flattenStatus(STATUS, { s1: "HQ" });
  assert.deepEqual(screenStatusColumns(columns).map((c) => c.key), ["site_name", "extra", "mac", "site_upgrade_status"]);
});

test("cancel: one POST to /cancel; nothing for an upgrade that already finished", async () => {
  stubMist({ "/orgs/org-1/devices/upgrade/up-2": STATUS });
  const ctx = testCtx({ role: "write" });
  assert.equal(await cancelUpgrade(ctx, "up-2"), "Cancelled upgrade up-2.");
  assert.deepEqual(ctx.writes, [{ method: "POST", path: "/orgs/org-1/devices/upgrade/up-2/cancel", body: undefined }]);

  stubMist({ "/orgs/org-1/devices/upgrade/up-2": { ...STATUS, status: "success" } });
  const done = testCtx({ role: "write" });
  assert.match(await cancelUpgrade(done, "up-2"), /already success; nothing to cancel/);
  assert.deepEqual(done.writes, []);
  assert.equal(isFinished({ upgrades: [{ upgrade: { status: "cancelled" } }] }), true);

  stubMist({ "/orgs/org-1/devices/upgrade/up-2": STATUS });
  const reader = testCtx({ role: "read" });
  await assert.rejects(cancelUpgrade(reader, "up-2"), /cannot make changes/);
  assert.deepEqual(reader.writes, []);
});

test("upgrade log: phase from Mist's status", () => {
  assert.equal(upgradePhase("scheduled"), "Pending");
  assert.equal(upgradePhase("queued"), "Pending");
  assert.equal(upgradePhase("upgrading"), "In progress");
  assert.equal(upgradePhase("downloaded"), "In progress");
  assert.equal(upgradePhase("completed"), "Finished");
  assert.equal(upgradePhase("Cancelled"), "Finished");
  assert.equal(upgradePhase(""), "");
});

test("upgrade log row: the reply the script reads (start_datetime, targets.devices)", () => {
  const item = { id: "up-2", site_upgrades: [{ site_id: "s1", upgrade_id: "su1" }] };
  const data = {
    ...STATUS, download_strategy: "big_bang",
    versions: [{ firmware_type: "junos", model_version: { "EX4100-48MP": "24.2R1" } }],
    upgrades: [{ site_id: "s1", upgrade: { id: "su1", status: "scheduled", targets: { devices: [
      { mac: "a", status: "scheduled" }, { mac: "b", status: "upgraded" }, { mac: "c", status: "failed" }] } } }],
  };
  const r = logRow(item, data, { s1: "HQ" });
  assert.equal(r.upgrade_id, "up-2");
  assert.equal(r.phase, "Pending");
  assert.equal(r.status, "scheduled");
  assert.equal(r.start, LATER);
  assert.equal(r.startMs, Date.parse(LATER));
  assert.equal(r.reboot_strategy, "serial");
  assert.equal(r.versions, "EX4100-48MP → 24.2R1");
  assert.equal(r.site_names, "HQ");
  assert.equal(r.site_upgrade_ids, "su1");
  assert.deepEqual([r.site_count, r.devices, r.upgraded, r.failed], [1, 3, 1, 1]);
});

test("upgrade log row: the OpenAPI reply (no top status, epoch start_time, target lists)", () => {
  const data = { id: "up-9", strategy: "big_bang", target_version: "23.4R2", upgrades: [
    { site_id: "s1", upgrade: { id: "su1", status: "completed", start_time: 1717658765, targets: { total: 4, upgraded: ["a", "b", "c"], failed: ["d"] } } },
    { site_id: "s2", upgrade: { id: "su2", status: "failed", start_time: 1717658700, targets: { total: 2, upgraded: ["e", "f"] } } },
  ] };
  const r = logRow({ id: "up-9" }, data, { s1: "HQ" });
  assert.equal(r.status, "failed");
  assert.equal(r.phase, "Finished");
  assert.equal(r.startMs, 1717658700000);
  assert.equal(r.start, "2024-06-06 07:25:00 UTC");
  assert.equal(r.reboot_strategy, "big_bang");
  assert.equal(r.versions, "23.4R2");
  assert.equal(r.site_names, "HQ, s2");
  assert.deepEqual([r.site_count, r.devices, r.upgraded, r.failed], [2, 6, 5, 1]);
});

test("upgrade log row: a site still running makes the whole upgrade in progress", () => {
  const data = { upgrades: [{ site_id: "s1", upgrade: { status: "completed" } }, { site_id: "s2", upgrade: { status: "upgrading" } }] };
  assert.equal(logRow({ id: "x" }, data).phase, "In progress");
});

test("upgrade log: newest start first, unknown starts last", () => {
  const rows = sortLog([{ upgrade_id: "a", startMs: 1 }, { upgrade_id: "b", startMs: null }, { upgrade_id: "c", startMs: 3 }]);
  assert.deepEqual(rows.map((r) => r.upgrade_id), ["c", "a", "b"]);
});

test("upgrade log: every upgrade read by ID; an AP upgrade dropped; an unreadable one kept with its ID", async () => {
  const calls = stubMist({
    "/orgs/org-1/devices/upgrade": [{ id: "up-old" }, { id: "up-new" }, { id: "up-ap" }, { id: "up-gone" }],
    "/orgs/org-1/devices/upgrade/up-old": { status: "completed", start_datetime: "2026-01-01T02:00:00Z", upgrades: [] },
    "/orgs/org-1/devices/upgrade/up-new": { status: "scheduled", start_datetime: "2026-11-01T02:00:00Z", upgrades: [] },
    "/orgs/org-1/devices/upgrade/up-ap": { device_type: "ap", status: "completed" },
    "/orgs/org-1/devices/upgrade/up-gone": null,
  });
  const { rows, failed } = await loadUpgradeLog(testCtx(), {});
  assert.deepEqual(rows.map((r) => [r.upgrade_id, r.phase]), [["up-new", "Pending"], ["up-old", "Finished"], ["up-gone", "Unknown"]]);
  assert.equal(failed, 1);
  assert.match(rows[2].status, /^could not read/);
  assert.equal(calls.filter((c) => c.startsWith("/orgs/org-1/devices/upgrade/")).length, 4);
});
