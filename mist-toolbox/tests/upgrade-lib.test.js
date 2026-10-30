// lib/upgrade.js, shared by Switch Site Upgrade and AP Site Upgrade: telling AP
// upgrades from switch upgrades, the start-time lead, and the status export for
// the OpenAPI reply (MACs listed by stage). The switch script's reply is covered
// in switch-site-upgrade.test.js.

import { strict as assert } from "node:assert";
import test from "node:test";

import { checkStart, defaultStart, flattenStatus, logRow, screenStatusColumns, targetStages, upgradeKind } from "../lib/upgrade.js";

const NOW = Date.parse("2026-10-10T12:00:00Z");

test("upgrade kind: device_type first, then the firmware, else unknown", () => {
  assert.equal(upgradeKind({ device_type: "gateway", versions: [{ firmware_type: "ap" }] }), "gateway");
  assert.equal(upgradeKind({ versions: [{ firmware_type: "ap", version: "0.14.29633" }] }), "ap");
  assert.equal(upgradeKind({ versions: [{ firmware_type: "junos", model_version: { "EX4100-48P": "23.4R2-S3" } }] }), "switch");
  assert.equal(upgradeKind({ target_version: "0.14.29633" }), "ap");
  assert.equal(upgradeKind({ target_version: "v0.1.543" }), "ap");
  assert.equal(upgradeKind({ target_version: "22.4R3-S2" }), "switch");
  assert.equal(upgradeKind({ status: "completed" }), "");
  assert.equal(upgradeKind(null), "");
});

test("start lead: two hours by default, any lead when asked", () => {
  assert.match(checkStart("2026-10-10T13:00:00Z", NOW), /at least 2 hours ahead/);
  assert.match(checkStart("2026-10-10T12:30:00Z", NOW, 60 * 60 * 1000), /at least 1 hour ahead/);
  assert.match(checkStart("2026-10-10T12:05:00Z", NOW, 15 * 60 * 1000), /at least 15 minutes ahead/);
  assert.equal(checkStart("2026-10-10T12:15:00Z", NOW, 15 * 60 * 1000), "");
  const d = defaultStart(NOW, 60);
  assert.ok(d.getTime() - NOW >= 60 * 60 * 1000 && d.getTime() % (15 * 60 * 1000) === 0, d.toISOString());
});

test("target stages: each MAC once, at the furthest stage it reached", () => {
  const stages = targetStages({ download_requested: ["a", "b", "c"], downloaded: ["a", "b"], upgraded: ["a"], failed: ["b"], skipped: ["d"], total: 4 });
  assert.deepEqual([...stages], [["b", "failed"], ["a", "upgraded"], ["c", "download_requested"], ["d", "skipped"]]);
  assert.equal(targetStages(undefined).size, 0);
});

test("status export of the OpenAPI reply: one row per MAC, named when known", () => {
  const status = { strategy: "rrm", target_version: "0.14.29633", upgrades: [
    { site_id: "s1", upgrade: { id: "su1", status: "upgrading", start_time: 1717658765, targets: { upgraded: ["m1"], downloading: ["m2"] } } },
  ] };
  const { columns, rows } = flattenStatus(status, { s1: "HQ" }, { m1: "hq-ap-1" });
  assert.deepEqual(columns.map((c) => c.key), ["site_name", "device_status", "mac", "name", "scheduled_time", "site_id",
    "site_upgrade_id", "site_upgrade_status", "strategy", "target_version"]);
  assert.deepEqual(rows.map((r) => [r.mac, r.name, r.device_status]), [["m1", "hq-ap-1", "upgraded"], ["m2", "", "downloading"]]);
  assert.equal(rows[0].scheduled_time, "2024-06-06 07:26:05 UTC");
  assert.equal(rows[0].strategy, "rrm");
  assert.deepEqual(screenStatusColumns(columns).map((c) => c.key), ["site_name", "device_status", "mac", "name", "site_upgrade_status"]);
});

test("log row: an AP version with no model list, and skipped APs counted", () => {
  const r = logRow({ id: "u" }, { status: "completed", versions: [{ firmware_type: "ap", version: "0.14.29633", force: false }],
    upgrades: [{ site_id: "s1", upgrade: { targets: { total: 5, upgraded: ["a", "b"], skipped: ["c", "d", "e"] } } }] });
  assert.equal(r.versions, "0.14.29633");
  assert.deepEqual([r.devices, r.upgraded, r.skipped, r.failed], [5, 2, 3, 0]);
});
