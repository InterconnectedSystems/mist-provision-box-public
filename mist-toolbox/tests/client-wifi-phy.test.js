// Client Wi-Fi PHY Inspector, added as written: finding the client's site,
// grading at every threshold edge, offline fallback and the workbook.

import { strict as assert } from "node:assert";
import test from "node:test";

import tool from "../tools/client-wifi-phy.js";
import { sheetNamed, stubMist, testCtx } from "./helpers.mjs";

const MAC = "aabbccddeeff";
const SITES = [{ id: "s1", name: "HQ" }, { id: "s2", name: "Branch" }];
const radio = (o) => ({ band_5: { channel: 36, bandwidth: 20, noise_floor: -95, util_all: 30, num_clients: 5, power: 17, ...o } });
const APS = [
  { type: "ap", name: "ap-serving", mac: "0a0027000001", radio_stat: radio({ bandwidth: 80 }) },
  { type: "ap", name: "ap-overlap", mac: "0a0027000002", radio_stat: radio({ channel: 44 }) },
  { type: "ap", name: "ap-clear", mac: "0a0027000003", radio_stat: radio({ channel: 149 }) },
];
const LIVE = {
  mac: MAC, hostname: "laptop-1", ssid: "corp", ap_mac: "0a0027000001", band: "5", channel: 36,
  proto: "ax", rssi: -60, snr: 30, tx_rate: 1000, rx_rate: 400, tx_retries: 5, tx_pkts: 995,
};

const routes = (site = "s1", o = {}) => ({
  "/orgs/org-1/sites": SITES,
  [`/sites/${site}/stats/clients/${MAC}`]: LIVE,
  [`/sites/${site}/stats/devices`]: APS,
  ...o,
});

const run = (params) => tool.run(testCtx({ params: { allSites: false, siteId: "s1", mac: "AA-BB-CC-DD-EE-FF", ...params } }));
const finding = (result, facet) => sheetNamed(result, "Findings").rows.find((r) => r.facet === facet);
const snap = (result, field) => sheetNamed(result, "PHY Snapshot").rows.find((r) => r[0] === field)?.[1];

test("a healthy live client: graded, matched to its AP, every sheet present", async () => {
  stubMist(routes());
  const result = await run({});
  assert.deepEqual(result.sheets.map((s) => s.name),
    ["Findings", "PHY Snapshot", "Time Series", "Sessions", "Events", "Channel Map", "Info"]);
  assert.equal(finding(result, "Signal").sev, "Good");
  assert.equal(finding(result, "SNR").sev, "Good");
  assert.equal(finding(result, "Noise floor").sev, "Good");
  assert.equal(finding(result, "PHY rate").sev, "Good", "1000 of a 1201 Mbps HE80 2SS ceiling");
  assert.equal(finding(result, "Retries").sev, "Good");
  assert.equal(snap(result, "AP"), "ap-serving");
  assert.equal(snap(result, "Connected now"), "Yes");
  assert.equal(snap(result, "Overlapping AP radios at site"), 1, "ch 44/20 sits inside 36/80; 149 does not");
  assert.deepEqual(sheetNamed(result, "Channel Map").rows.map((r) => [r.ap, r.span, r.rel]), [
    ["ap-serving", "36–48", "Serving"], ["ap-overlap", "44–44", "Overlaps serving"], ["ap-clear", "149–149", "Clear"],
  ]);
  assert.match(result.summary, /^laptop-1 at HQ: Good\. 0 issue\(s\)/);
  assert.match(result.filename, /^mist_client_phy_aabbccddeeff_Acme_Corp_/);
});

test("RSSI, SNR and noise grade correctly on each side of every cut", async () => {
  const cases = {
    rssi: [[-65, "Good"], [-66, "Warning"], [-70, "Warning"], [-71, "Serious"], [-75, "Serious"], [-76, "Critical"]],
    snr: [[25, "Good"], [24, "Warning"], [20, "Warning"], [19, "Serious"], [15, "Serious"], [14, "Critical"]],
    noise: [[-90, "Good"], [-89, "Warning"], [-85, "Warning"], [-84, "Serious"], [-80, "Serious"], [-79, "Critical"]],
  };
  const facet = { rssi: "Signal", snr: "SNR", noise: "Noise floor" };
  for (const [metric, rows] of Object.entries(cases)) {
    for (const [v, want] of rows) {
      const live = metric === "noise" ? LIVE : { ...LIVE, [metric]: v };
      const aps = metric === "noise" ? [{ ...APS[0], radio_stat: radio({ bandwidth: 80, noise_floor: v }) }] : APS;
      stubMist(routes("s1", { [`/sites/s1/stats/clients/${MAC}`]: live, "/sites/s1/stats/devices": aps }));
      assert.equal(finding(await run({}), facet[metric]).sev, want, `${metric} ${v}`);
    }
  }
});

test("all sites: the org search picks the site that saw the client last", async () => {
  const calls = stubMist(routes("s2", {
    "/orgs/org-1/clients/search": { results: [
      { mac: MAC, site_id: "s1", last_seen: 100 }, { mac: MAC, site_id: "s2", last_seen: 200 },
    ] },
  }));
  const result = await run({ allSites: true, siteId: undefined });
  assert.match(result.summary, / at Branch:/);
  assert.ok(calls.some((c) => c.startsWith(`/sites/s2/stats/clients/${MAC}`)));
});

test("all sites: when the org search fails, each site is asked in turn", async () => {
  stubMist(routes("s2", { "/orgs/org-1/clients/search": () => { throw new Error("forbidden"); } }));
  const result = await run({ allSites: true, siteId: undefined });
  assert.match(result.summary, / at Branch:/);
});

test("a client no site has seen is a clear error", async () => {
  stubMist(routes("s1", { "/orgs/org-1/clients/search": { results: [] } }));
  await assert.rejects(run({ allSites: true, siteId: undefined }), /not seen at any site in the past day/);
  await assert.rejects(run({ mac: "nope" }), /12 hex digits/);
});

test("an offline client falls back to its last-known record", async () => {
  stubMist(routes("s1", {
    [`/sites/s1/stats/clients/${MAC}`]: null,
    "/sites/s1/clients/search": { results: [
      { mac: MAC, last_seen: 100, rssi: -50 },
      { mac: MAC, last_seen: 200, rssi: -72, band: "5", last_ap: "0a0027000001", hostname: "phone-9" },
    ] },
  }));
  const result = await run({});
  const signal = finding(result, "Signal");
  assert.equal(signal.sev, "Serious");
  assert.match(signal.evidence, /RSSI -72 dBm \(last known/);
  assert.equal(snap(result, "Connected now"), "No");
  assert.equal(snap(result, "AP"), "ap-serving");
  assert.match(result.summary, /^phone-9 at HQ: .*\(client offline, last-known values\)$/);
});
