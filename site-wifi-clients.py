#!/usr/bin/env python3
"""
Export Juniper Mist Wi-Fi client (user) details from every site
into a single Excel sheet for filtering.

Same auth/org/site walk as ap-org-list.py.

Primary endpoint:
  GET /api/v1/sites/{site_id}/stats/clients

Key columns include site_name, proto (a/b/g/n/ac/ax/be),
wifi_standard (802.11ax), band, tx_rate, rx_rate, SSID, identity, RF stats.
"""

import getpass
import json
from datetime import datetime, timezone

import pandas as pd
import requests

# Change host if your org is not on Global 04 (gc2).
base_url = "https://api.gc2.mist.com/api/v1"

api_key = getpass.getpass("Enter your API key: ")
headers = {
    "Authorization": f"Token {api_key}",
    "Content-Type": "application/json",
}

PROTO_LABEL = {
    "b": "802.11b",
    "g": "802.11g",
    "a": "802.11a",
    "n": "802.11n",
    "ac": "802.11ac",
    "ax": "802.11ax",
    "be": "802.11be",
}

BAND_LABEL = {
    "24": "2.4 GHz",
    "5": "5 GHz",
    "5-dedicated": "5 GHz (dedicated)",
    "5-selectable": "5 GHz (selectable)",
    "6": "6 GHz",
    "6-dedicated": "6 GHz (dedicated)",
    "6-selectable": "6 GHz (selectable)",
}

# Preferred column order for the filterable sheet
PREFERRED_COLUMNS = [
    "site_name",
    "site_id",
    "hostname",
    "username",
    "mac",
    "ip",
    "ip6",
    "ssid",
    "vlan_id",
    "is_guest",
    "manufacture",
    "family",
    "model",
    "os",
    "ap_mac",
    "ap_id",
    "band",
    "band_label",
    "channel",
    "proto",
    "wifi_standard",
    "dual_band",
    "tx_rate",
    "rx_rate",
    "rssi",
    "snr",
    "key_mgmt",
    "uptime",
    "idle_time",
    "power_saving",
    "tx_bps",
    "rx_bps",
    "tx_bytes",
    "rx_bytes",
    "tx_packets",
    "rx_packets",
    "tx_retries",
    "rx_retries",
    "last_seen",
    "last_seen_utc",
    "wlan_id",
    "psk_id",
]


def flatten_value(value):
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False)
    if value is None:
        return ""
    return value


def epoch_to_utc(value):
    try:
        ts = float(value)
        if ts > 1e12:
            ts = ts / 1000.0
        return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    except (TypeError, ValueError, OSError):
        return ""


def api_get(path, label, params=None):
    try:
        resp = requests.get(
            f"{base_url}{path}",
            headers=headers,
            params=params or {},
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json()
    except requests.exceptions.HTTPError as e:
        status = e.response.status_code if e.response is not None else "?"
        if status == 403:
            print(f"Forbidden ({label}): invalid API key or insufficient permissions.")
        else:
            print(f"HTTP error {label}: {e}")
        return None
    except requests.exceptions.RequestException as e:
        print(f"Error {label}: {e}")
        return None


def list_clients(site_id, site_name, page_size=1000):
    """Paginate GET /sites/{site_id}/stats/clients."""
    clients = []
    page = 1
    while True:
        data = api_get(
            f"/sites/{site_id}/stats/clients",
            f"clients for {site_name} page {page}",
            params={"limit": page_size, "page": page},
        )
        if data is None:
            break
        if isinstance(data, dict):
            batch = data.get("results") or data.get("clients") or []
        elif isinstance(data, list):
            batch = data
        else:
            batch = []
        if not batch:
            break
        clients.extend(batch)
        if len(batch) < page_size:
            break
        page += 1
    return clients


print("Fetching user details to retrieve organization ID")
self_data = api_get("/self", "fetching user details")
if not self_data:
    raise SystemExit(1)

org_id = None
for privilege in self_data.get("privileges", []):
    if privilege.get("scope") == "org":
        org_id = privilege.get("org_id")
        break

if not org_id:
    print("No organization ID found in user privileges.")
    raise SystemExit(1)

print(f"Fetching all sites for organization ID: {org_id}")
sites = api_get(f"/orgs/{org_id}/sites", "fetching sites")
if sites is None:
    raise SystemExit(1)
if not sites:
    print("No sites found in the organization.")
    raise SystemExit(0)

all_rows = []
all_fields = set()
site_counts = []

for site in sites:
    site_id = site.get("id")
    site_name = site.get("name", "unknown_site")
    print(f"\nProcessing site: {site_name} (ID: {site_id})")

    clients = list_clients(site_id, site_name)
    print(f"  Found {len(clients)} Wi-Fi clients.")
    site_counts.append(
        {
            "site_name": site_name,
            "site_id": site_id,
            "client_count": len(clients),
        }
    )

    for client in clients:
        if not isinstance(client, dict):
            continue
        proto = client.get("proto", "")
        band = str(client.get("band", "") or "")
        row = {
            field: flatten_value(client.get(field))
            for field in client.keys()
        }
        row["site_name"] = site_name
        row["site_id"] = site_id
        row["proto"] = proto
        row["wifi_standard"] = PROTO_LABEL.get(str(proto).lower(), proto)
        row["band"] = band
        row["band_label"] = BAND_LABEL.get(band, band)
        row["last_seen_utc"] = epoch_to_utc(client.get("last_seen"))
        guest = client.get("guest")
        if isinstance(guest, dict):
            row["guest_name"] = guest.get("name", "")
            row["guest_email"] = guest.get("email", "")
            row["guest_company"] = guest.get("company", "")
            row["guest_authorized"] = guest.get("authorized", "")
        all_fields.update(row.keys())
        all_rows.append(row)

# Build a stable column order: preferred first, then remaining alpha
remaining = sorted(f for f in all_fields if f not in PREFERRED_COLUMNS)
columns = [c for c in PREFERRED_COLUMNS if c in all_fields] + remaining

excel_filename = "all_sites_wifi_clients.xlsx"
print(f"\nWriting to {excel_filename}")

clients_df = pd.DataFrame(all_rows, columns=columns) if all_rows else pd.DataFrame(
    columns=["site_name", "note"]
)
if clients_df.empty:
    clients_df = pd.DataFrame([{"site_name": "", "note": "No Wi-Fi clients found"}])

summary_df = pd.DataFrame(site_counts)
if not summary_df.empty:
    summary_df.loc[len(summary_df)] = {
        "site_name": "TOTAL",
        "site_id": "",
        "client_count": int(summary_df["client_count"].sum()),
    }

try:
    with pd.ExcelWriter(excel_filename, engine="xlsxwriter") as writer:
        clients_df.to_excel(writer, sheet_name="WiFi_Clients", index=False)
        summary_df.to_excel(writer, sheet_name="Site_Summary", index=False)

        workbook = writer.book
        header_fmt = workbook.add_format(
            {"bold": True, "bg_color": "#1F4E79", "font_color": "white", "border": 1}
        )
        worksheet = writer.sheets["WiFi_Clients"]
        worksheet.freeze_panes(1, 2)
        worksheet.autofilter(0, 0, max(len(clients_df), 1), max(len(clients_df.columns) - 1, 0))
        for col_idx, col_name in enumerate(clients_df.columns):
            worksheet.write(0, col_idx, col_name, header_fmt)
            width = min(max(12, len(str(col_name)) + 2), 36)
            worksheet.set_column(col_idx, col_idx, width)

    print(f"Successfully wrote Wi-Fi client data to {excel_filename}")
except Exception as e:
    print(f"Error writing Excel file: {e}")
    raise SystemExit(1)

print("\nAll sites processed.")
print(f"Sites: {len(sites)}")
print(f"Clients: {len(all_rows)}")
