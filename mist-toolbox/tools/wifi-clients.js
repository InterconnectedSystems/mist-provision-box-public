// Ported from site-wifi-clients.py.
//
// The Python leaned on pandas for exactly two things — a union of whatever keys
// the client objects happened to carry, and an ExcelWriter bridge — so neither
// pandas nor xlsxwriter is needed here. The dynamic column union is reproduced
// faithfully, because a missing column means a missing field in the export.
//
// Three things the Python did that are fixed here:
//   * it wrote a fixed `all_sites_wifi_clients.xlsx`, overwriting every run;
//   * it picked the first org with scope=="org" and never said which, where the
//     toolbox lets you choose;
//   * its pagination stopped on a short page, which under-reports a busy site
//     whose true count is only in X-Page-Total (see lib/paginate.js).

const PROTO_LABEL = {
  b: "802.11b", g: "802.11g", a: "802.11a", n: "802.11n",
  ac: "802.11ac", ax: "802.11ax", be: "802.11be",
};

const BAND_LABEL = {
  24: "2.4 GHz",
  5: "5 GHz",
  "5-dedicated": "5 GHz (dedicated)",
  "5-selectable": "5 GHz (selectable)",
  6: "6 GHz",
  "6-dedicated": "6 GHz (dedicated)",
  "6-selectable": "6 GHz (selectable)",
};

/** Column order for the filterable sheet; anything else follows alphabetically. */
export const PREFERRED_COLUMNS = [
  "site_name", "site_id", "hostname", "username", "mac", "ip", "ip6", "ssid",
  "vlan_id", "is_guest", "manufacture", "family", "model", "os", "ap_mac", "ap_id",
  "band", "band_label", "channel", "proto", "wifi_standard", "dual_band",
  "tx_rate", "rx_rate", "rssi", "snr", "key_mgmt", "uptime", "idle_time",
  "power_saving", "tx_bps", "rx_bps", "tx_bytes", "rx_bytes", "tx_packets",
  "rx_packets", "tx_retries", "rx_retries", "last_seen", "last_seen_utc",
  "wlan_id", "psk_id",
];

/** A short, readable subset for the on-screen preview. */
const PREVIEW_COLUMNS = [
  "site_name", "hostname", "username", "mac", "ip", "ssid",
  "band_label", "wifi_standard", "rssi", "snr", "last_seen_utc",
];

/** flatten_value: nested structures become JSON so a cell can hold them. */
export function flattenValue(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}

/**
 * The endpoint answers as a bare list, as {results: []} or as {clients: []}.
 * getAll handles the first two — the search shape it delegates, a bare list it
 * returns as-is — but an unrecognised object comes back wrapped as [object],
 * so the {clients: []} form has to be unwrapped here.
 */
export function asClientList(data) {
  if (!Array.isArray(data)) return (data && (data.clients || data.results)) || [];
  if (data.length === 1 && data[0] && typeof data[0] === "object" && !Array.isArray(data[0])) {
    const inner = data[0].clients || data[0].results;
    if (Array.isArray(inner)) return inner;
  }
  return data;
}

export default {
  id: "wifi-clients",
  name: "Wi-Fi Clients Export",
  description: "Every connected Wi-Fi client at one site or across all sites in an org, with RF stats, 802.11 "
    + "standard and band labels, UTC last-seen times and flattened guest-portal fields.",
  tag: "Mist API",
  needs: { mistToken: true, org: true },
  scope: "site",
  notice: "This export contains personal data — usernames, hostnames, MAC and IP addresses, and "
    + "guest names, emails and companies. Handle and store the file accordingly.",
  params: [
    {
      id: "onlySitesWithClients",
      label: "Omit sites with no clients from the summary",
      type: "checkbox",
      default: false,
    },
  ],

  async run(ctx) {
    const { getAll, pool, POOL_LIMIT, log, progress } = ctx;

    const scope = await ctx.targetSites();
    const { sites } = scope;
    log(`Scope: ${scope.label}.`, "info");

    let done = 0;
    const perSite = await pool(POOL_LIMIT, sites.map((site) => async () => {
      if (ctx.signal.aborted) return { site, clients: [] };
      try {
        const data = await getAll(`/sites/${site.id}/stats/clients`);
        return { site, clients: asClientList(data).filter((c) => c && typeof c === "object") };
      } catch (e) {
        log(`${site.name || site.id}: ${e.message}`, "err");
        return { site, clients: [] };
      } finally {
        done += 1;
        progress(done, sites.length, "sites");
      }
    }));

    const rows = [];
    const summary = [];
    const fields = new Set();

    for (const { site, clients } of perSite) {
      const siteName = site.name || "unknown_site";
      if (!(ctx.params.onlySitesWithClients && !clients.length)) {
        summary.push({ site_name: siteName, site_id: site.id || "", client_count: clients.length });
      }
      for (const client of clients) {
        const row = {};
        for (const k of Object.keys(client)) row[k] = flattenValue(client[k]);
        const proto = client.proto ?? "";
        const band = String(client.band ?? "");
        row.site_name = siteName;
        row.site_id = site.id || "";
        row.proto = proto;
        row.wifi_standard = PROTO_LABEL[String(proto).toLowerCase()] ?? proto;
        row.band = band;
        row.band_label = BAND_LABEL[band] ?? band;
        row.last_seen_utc = ctx.epochToUtc(client.last_seen);
        if (client.guest && typeof client.guest === "object") {
          row.guest_name = client.guest.name ?? "";
          row.guest_email = client.guest.email ?? "";
          row.guest_company = client.guest.company ?? "";
          row.guest_authorized = client.guest.authorized ?? "";
        }
        for (const k of Object.keys(row)) fields.add(k);
        rows.push(row);
      }
    }

    // Preferred columns first (only those actually present), then the rest
    // alphabetically — the Python's column order, reproduced.
    const remaining = [...fields].filter((f) => !PREFERRED_COLUMNS.includes(f)).sort();
    const order = PREFERRED_COLUMNS.filter((c) => fields.has(c)).concat(remaining);

    const total = summary.reduce((n, s) => n + s.client_count, 0);
    log(`${total} client(s) across ${sites.length} site(s), ${order.length} columns.`, "ok");

    const { sheet } = ctx.xlsx;
    const clientCols = order.length
      ? order.map((k) => ({ header: k, key: k, width: Math.min(Math.max(12, k.length + 2), 36) }))
      : [{ header: "site_name" }, { header: "note" }];
    const clientRows = rows.length ? rows : [{ site_name: "", note: "No Wi-Fi clients found" }];

    summary.sort((a, b) => (a.site_name || "").localeCompare(b.site_name || ""));
    const summaryRows = summary.concat([{ site_name: "TOTAL", site_id: "", client_count: total }]);

    const previewCols = PREVIEW_COLUMNS.filter((c) => fields.has(c)).map((k) => ({ header: k, key: k }));

    return {
      summary: `${total} clients across ${sites.length} sites`,
      filename: ctx.stampedName("mist_wifi_clients", scope.fileLabel, "xlsx"),
      sheets: [
        // freeze_panes(1, 2) in the Python: header row plus the two site columns.
        sheet("WiFi_Clients", clientCols, clientRows, {
          freeze: { row: 1, col: 2 }, tabColor: "1F4E79",
        }),
        sheet("Site_Summary", [
          { header: "site_name", key: "site_name" },
          { header: "site_id", key: "site_id" },
          { header: "client_count", key: "client_count" },
        ], summaryRows),
      ],
      preview: previewCols.length
        ? { title: "Wi-Fi clients", columns: previewCols, rows }
        : null,
    };
  },
};
