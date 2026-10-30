# Mist Provision Box

<p align="center">
  <a href="https://github.com/InterconnectedSystems/mist-provision-box-public/releases/latest/download/mist-provision-box.zip"><img src=".github/download-button.svg" alt="Download mist-provision-box.zip (latest release)" width="440"></a>
</p>

**Juniper Mist and Juniper SSR tools in a browser extension: read-only reporting by default,
and tools that make changes when you need them.** Mist Provision Box is the write-enabled
edition of Mist Toolbox. Paste a Mist API token, pick an org (and optionally one site), pick a
tool, and get the answer on screen and as a styled Excel workbook. The built-in tools only read,
except **Switch Site Upgrade** and **AP Site Upgrade**, which schedule firmware upgrades, and
**SSID Banned / Approved Clients**, which sets Mist's client lists. A tool that makes
changes, built in or added by you, is labelled **Makes changes**, warned about when you install
it, and asks for confirmation before it runs.
There is no Python, no server and no install beyond the extension, and the extension ships its
own **LLM spec**, so any AI assistant can turn a script or a one-line idea into a new tool.

The **Download** button above always gets the latest release's
[`mist-provision-box.zip`](https://github.com/InterconnectedSystems/mist-provision-box-public/releases/latest/download/mist-provision-box.zip), ready for **Load unpacked**. It is also on the
[Releases page](https://github.com/InterconnectedSystems/mist-provision-box-public/releases/latest). It
installs alongside the read-only Mist Toolbox. Full steps: **[INSTALL.md](INSTALL.md)**.

**[Install guide](INSTALL.md)** · **[Add your own tools](ADDING_TOOLS.md)** · [All releases](https://github.com/InterconnectedSystems/mist-provision-box-public/releases/latest) · [Extension README](mist-toolbox/README.md)

![The tool menu](mist-toolbox/docs/screenshots/02-home.png)

## What you can do with it

### Wireless
- **Find every SSID that actually applies at each site**, including ones pushed down from org
  WLAN templates, with auth type, VLAN, bands and which template it came from. *(SSID Report)*
- **Export every connected Wi-Fi client**: hostname, user, MAC, IP, SSID, band, 802.11
  standard, RSSI/SNR, last seen and guest-portal details, one site or the whole org.
  *(Wi-Fi Clients Export)*
- **Root-cause why one client keeps disconnecting**: RF and SNR, 802.11 reason codes, DHCP
  after roam, RRM channel changes, DFS radar on the AP it was on, and Teams/Zoom call quality,
  correlated into a verdict. *(Disconnect Console)*
- **Inspect one client's radio link**: RSSI, SNR and noise floor graded against design
  thresholds, PHY rate against what the link could do, retries, channel load and non-Wi-Fi
  interference, overlapping AP radios, Wi-Fi generation and roaming, as a colour-coded
  dashboard. *(Client Wi-Fi PHY Inspector)*
- **Schedule AP firmware upgrades**: tick any number of sites, see the AP models there with
  their current versions, and pick the target version from the list Mist offers for every model
  you tick. Roll it out all at once, one AP at a time, in canary phases, or in radio-aware RRM
  batches that keep neighbouring APs apart, with a failure limit. Preview every AP, including
  the ones Mist will skip because they are already on that version or newer (or force them).
  Keeps a log of every AP upgrade in the org with its upgrade ID, shows an upgrade's status per
  AP (both exported to Excel) and cancels one. Makes changes, so nothing is sent until you
  preview, schedule and confirm. *(AP Site Upgrade)*
- **Ban or approve the clients on one SSID**: get the live clients on an SSID at one site or
  across the org, pick them by device family, manufacturer, model, OS, MAC type, band, VLAN and
  more, review and exclude them one by one, then push their MACs to the Mist banned or approved
  client list for the site or org, and turn on banned-client blocking for the WLAN. Shows what
  is on the lists now. Makes changes, so every request is previewed and confirmed first, and a
  token that cannot make changes sends nothing. *(SSID Banned / Approved Clients)*

### Switching
- **Audit switch software**: every switch's model, serial, firmware, status, IP, uptime and
  per-member versions for Virtual Chassis. *(Switch Software Report)*
- **Inventory every switch port**: 41 columns of live status, speed, VLAN, PoE draw, LLDP
  neighbour and STP, merged with the configured port profile and attributed to the right VC
  member. *(Switch Port Inventory)*
- **Back up switch configurations**: one `.txt` per switch, or a `.zip` with a folder per site
  and an index. *(Switch Config Export)*
- **Map your IP space**: every IRB/VLAN interface address with subnet, mask, broadcast and
  usable range, with duplicate and overlapping networks flagged across sites.
  *(IP Blocks / IRB Report)*
- **Check power supply redundancy**: every switch's PSUs, per Virtual Chassis member, with
  failed supplies, switches running on a single supply, and VC members that stop reporting
  flagged. *(Switch PSU Status)*
- **Compare additional CLI**: every "additional CLI commands" block at template, switch-rule,
  site and device level, side by side, with a de-duplicated list of commands. *(Switch Additional CLI)*
- **Schedule switch firmware upgrades**: tick any number of sites, see the switch models there
  with their current versions, and pick each model's target version from the list Mist offers.
  Preview every switch that would be upgraded, then schedule it with a serial or big-bang
  reboot. Keeps a log of every switch upgrade in the org (pending, in progress and finished)
  with its upgrade ID, shows an upgrade's status (both exported to Excel) and cancels one.
  Makes changes, so nothing is sent until you preview, schedule and confirm.
  *(Switch Site Upgrade)*

### Routing
- **See every BGP session and WAN peer path at once**: switch BGP (EVPN overlay and underlay),
  WAN-edge BGP on SSR and SRX, and every SSR peer path and SRX IPsec path with latency, jitter,
  loss and MOS, for one site or the whole org in a single org-wide pass. Down, degraded and
  recently re-established sessions are listed first, on a colour board you can open full
  screen. *(BGP Sessions)*

### Operations
- **See what's alarming**: every alarm over the past day or week, by site and by type, with
  severity, affected devices and acknowledgement status. *(Site Alarms)*
- **Prove a change window was clean** on Juniper SSR: snapshot BGP, OSPF, interfaces,
  adjacencies, node status, sessions and alarms on every router before a change, then again
  after. The output is laid out like the CLI and every changed field is highlighted. Opens in
  its own tab. *(SSR Pre/Post Check)*

### Making changes
- **Provision with your own tools**: a tool you add can send changes to Mist (POST, PUT, PATCH or
  DELETE) through the toolbox, for example to set up sites or settings in bulk. The example
  *Site Notes* tool shows the safe pattern: a dry run first, a preview of every change, then
  apply, with a sheet recording what changed.
- **Know what your token can do**: once validated, a badge by the Organization picker shows the
  token's permission in that org (*Read-only token (Observer)*, *Can make changes (Network
  Admin)*, *Full admin (Super User)*…), and it updates when you switch org.

### Every report
- **One site or the whole org**: tick *All sites in the org*, or pick a site.
- **Excel output**: header styling, frozen header row, filters and sized columns,
  timestamped filenames, saved to your downloads.
- **Read-only by default**: every built-in tool only reads except Switch Site Upgrade, AP Site
  Upgrade and SSID Banned / Approved Clients, and every
  card says **Read-only** or **Makes changes**. A tool that makes changes shows a red banner and asks for confirmation,
  naming the org and your token's permission, before it runs. Best practice is a read-only
  (Observer) token unless you are about to make changes.
- **The token stays on Mist**: it lives in that tab's memory only, is never saved, is never given
  to a tool, and is wiped after 30 idle minutes. The page's security policy lets nothing on it
  reach any host except the Mist regions in the region list.

## Additive: bring your own tools, with the LLM spec built in

The tools above are a starting point. A tool is one JavaScript file, and the toolbox provides
everything around it: the menu card, credentials, site picker, settings form, progress, preview
and Excel output. So adding a tool doesn't mean changing the extension.

You don't have to write the file either. The extension carries **its own LLM spec**,
[`TOOL_PROMPT.md`](mist-toolbox/docs/TOOL_PROMPT.md): a ready-made prompt that teaches any AI
assistant the tool format, the helpers, the security rules and two full working examples: a
read-only report (the default) and a tool that makes changes.

1. **Manage tools → Copy AI prompt**
2. Paste it into Claude, ChatGPT, Copilot or any assistant, then paste your existing
   Python/Node script, or just describe the report you want, below the marked line.
3. Save the reply as a `.js` file, then **Manage tools → Install**. It is checked first,
   written into the extension, and appears in the menu straight away. A tool that makes changes
   gets a strong warning at this step; read it before installing.
4. Remove it any time with the **Remove** button on its card.

![An AI-written tool passes the check](mist-toolbox/docs/screenshots/18-manage-check-passed.png)

![The new tool in the menu, marked added](mist-toolbox/docs/screenshots/20-home-added-tool.png)

The full walkthrough with screenshots is in **[ADDING_TOOLS.md](ADDING_TOOLS.md)**.

## Install

Chrome or Edge, on Windows, macOS or Linux:

1. Download **[`mist-provision-box.zip`](https://github.com/InterconnectedSystems/mist-provision-box-public/releases/latest/download/mist-provision-box.zip)** from the
   [Releases page](https://github.com/InterconnectedSystems/mist-provision-box-public/releases/latest)
   or run
   `gh release download -R InterconnectedSystems/mist-provision-box-public -p mist-provision-box.zip`.
   Unzip it somewhere permanent (the browser runs the extension from that folder).
2. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
3. **Load unpacked** → select the unzipped **`mist-provision-box`** folder.
4. Pin the icon, click it, choose your region, paste an API token (a read-only Observer token is
   recommended), **Validate**.

Details, updating and troubleshooting: **[INSTALL.md](INSTALL.md)**.

## Screenshots

All screenshots use synthetic data ("Demo Org", example.com names, private addresses). They are
generated by `node --experimental-websocket mist-toolbox/scripts/screenshots/capture.mjs`,
which drives the real extension in headless Chromium. Most were taken from the read-only Mist
Toolbox: the reports look the same here, while the name, the token badge and the
**Read-only** / **Makes changes** labels are new. The tool menu and SSID Banned / Approved
Clients shots are from Provision Box itself.

### SSID Banned / Approved Clients

![Live clients on one SSID, picked by attribute and reviewed](mist-toolbox/docs/screenshots/09d-ssid-clients-pick.png)
**Pick clients by attribute and review them.** Here the Apple clients on *DemoCorp* at one site.

| | |
|---|---|
| ![Every request listed before anything is sent](mist-toolbox/docs/screenshots/09e-ssid-clients-preview.png)<br>**Push**: every request is listed before anything is sent | ![What is on the lists now](mist-toolbox/docs/screenshots/09f-ssid-clients-current.png)<br>**Current lists**: what is banned or approved in Mist now |

### Reports

| | |
|---|---|
| ![Switch Software Report, one site](mist-toolbox/docs/screenshots/04-switch-report-single-site.png)<br>**Switch Software Report**, one site | ![SSID Report](mist-toolbox/docs/screenshots/03-ssid-report.png)<br>**SSID Report** |
| ![Switch Port Inventory](mist-toolbox/docs/screenshots/09-port-inventory.png)<br>**Switch Port Inventory** | ![Switch Config Export](mist-toolbox/docs/screenshots/05-switch-config-export.png)<br>**Switch Config Export** |
| ![IP Blocks / IRB Report](mist-toolbox/docs/screenshots/08-ip-blocks.png)<br>**IP Blocks / IRB Report** | ![Site Alarms](mist-toolbox/docs/screenshots/06-site-alarms.png)<br>**Site Alarms** |
| ![Wi-Fi Clients Export](mist-toolbox/docs/screenshots/07-wifi-clients.png)<br>**Wi-Fi Clients Export** | ![Disconnect Console](mist-toolbox/docs/screenshots/13-disconnect-console.png)<br>**Disconnect Console** |
| ![Switch PSU Status](mist-toolbox/docs/screenshots/09b-switch-psu-status.png)<br>**Switch PSU Status** | ![Switch Additional CLI](mist-toolbox/docs/screenshots/09c-switch-additional-cli.png)<br>**Switch Additional CLI** |
| ![Client Wi-Fi PHY Inspector](mist-toolbox/docs/screenshots/07b-client-wifi-phy.png)<br>**Client Wi-Fi PHY Inspector** | |
| ![SSR post-check, changes highlighted](mist-toolbox/docs/screenshots/11-ssr-post-highlighted.png)<br>**SSR Pre/Post**: changed fields highlighted | ![SSR pre and post side by side](mist-toolbox/docs/screenshots/12-ssr-side-by-side.png)<br>**SSR Pre/Post**: side by side |

Every screenshot with a caption: [`mist-toolbox/docs/screenshots/`](mist-toolbox/docs/screenshots/README.md).

## What's in this repository

- [`mist-toolbox/`](mist-toolbox/) is the extension (the folder keeps its original name): tools,
  shared libraries, docs and 314 tests (`npm test`).
- The original scripts (`mist_*.py`, `site-wifi-clients.py`, `pre-post-check-gui.py`,
  `mist_switch_report.js`, `site-alarms.js`, `client-wifi-phy.js`, `switch-psu-status.js`,
  `switch-additional-cli.js`, `switch-site-upgrade.py`, `bgp-sessions.js`, `ssid-client-lists.js`)
  are kept for reference and for comparing output. AP Site Upgrade has no original script: it is
  modelled on Switch Site Upgrade.
