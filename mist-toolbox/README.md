# Mist Provision Box

A Chrome/Edge extension (Manifest V3) that gathers the Juniper Mist and SSR
reporting scripts in this repository into one place, plus the existing
Mist Disconnect Console. It is the write-enabled edition of Mist Toolbox: the
built-in tools only read, except Switch Site Upgrade, AP Site Upgrade and SSID
Banned / Approved Clients, and tools you add may also make changes to Mist. Every tool that makes changes is
labelled, warned about and confirmed before it runs.

Everything runs in the browser. There is no Python to install, no server to run,
no backend to secure, and no third-party JavaScript — not one dependency.
Spreadsheets land in the browser's normal download list.

> **New here?** Get `mist-provision-box.zip` from this repository's
> [Releases page](https://github.com/InterconnectedSystems/mist-provision-box-public/releases/latest), then follow
> [INSTALL.md](../INSTALL.md). · [Add your own tools with an AI assistant](../ADDING_TOOLS.md)

## Install

The extension is plain static files; there is nothing to build.

**Chrome**

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this directory (`mist-toolbox` in a clone, `mist-provision-box` from the release ZIP)
5. Pin the **Mist Provision Box** icon to the toolbar, then click it

**Edge**

1. Go to `edge://extensions`
2. Turn on **Developer mode** (left sidebar)
3. Click **Load unpacked**
4. Select this directory
5. Click the Mist Provision Box icon

Edge and Chrome share the same engine here; `minimum_chrome_version` is 116 and
Edge 116+ satisfies it.

To update, replace the directory's contents and press the reload arrow on the
extension's card. It loads beside the read-only Mist Toolbox without clashing.

## Using it

Clicking the toolbar icon opens the toolbox in a tab — one tab, reused.

1. Pick your **Mist region** and paste an **API token**, then press **Validate
   token**. Create the token in the Mist portal under *My Account -> API
   Tokens*. A read-only (Observer) token is recommended and is enough for every
   built-in tool; use one that can make changes only when you are about to run
   a tool that makes changes. The badge next to the Organization picker shows
   what the token may do in the selected org, and updates when you switch org.
2. Choose an **organization** if the token sees more than one.
3. Pick a tool, set its options, press **Run**.
4. The `.xlsx` downloads on completion. The on-screen table is a preview capped
   at 200 rows; the file always has everything.

The token lives in memory in that tab only. It is never written to
`chrome.storage`, `localStorage` or IndexedDB, never sent to the service worker,
never handed to a tool, never logged, and it is wiped after 30 minutes without
interaction, when you press **End session**, or whenever the tab closes or
reloads. `toolbox.html` and `console.html` carry a Content-Security-Policy whose
`connect-src` is exactly the 13 Mist regions (plus `default-src 'self'`,
`frame-src 'none'` and `form-action 'none'`), so nothing on those pages can
reach any other host, by any means. `tests/policy.test.js` keeps that list
identical to the region drop-down.

Every card says **Read-only** or **Makes changes**. A tool that makes changes
shows a red banner and asks for confirmation, naming the org and the token's
permission, before it runs. The built-in tools are read-only, except Switch
Site Upgrade, AP Site Upgrade and SSID Banned / Approved Clients; `tests/policy.test.js` allows only the built-ins it names to make
changes, and requires each to declare `writes: true`.

## The tools

| Tool | Ported from | Level | Needs |
|---|---|---|---|
| **Disconnect Console** | the existing v1.4 extension | Site · Client | its own token (opens in its own tab) |
| **SSID Report** | `mist_ssid_report.py` | Site · Org | Mist token + org |
| **Switch Software Report** | `mist_switch_report.js` | Site · Org | Mist token + org |
| **Switch Config Export** | `mist_ip_blocks.py --save-configs` | Site · Org | Mist token + org |
| **Site Alarms** | `site-alarms.js` (added as written) | Site · Org | Mist token + org |
| **Client Wi-Fi PHY Inspector** | `client-wifi-phy.js` (added as written) | Site · Client | Mist token + org |
| **Switch PSU Status** | `switch-psu-status.js` (added as written) | Site · Org | Mist token + org |
| **Switch Additional CLI** | `switch-additional-cli.js` (added as written) | Site · Org | Mist token + org |
| **BGP Sessions** | `bgp-sessions.js` (added as written) | Site · Org | Mist token + org |
| **Switch Site Upgrade** (makes changes; its own screen: tick sites, pick each model's version from Mist's list; a log of every switch upgrade with its ID) | `switch-site-upgrade.py` | Site · Org | Mist token + org; a token that can make changes to schedule or cancel |
| **AP Site Upgrade** (makes changes; its own screen: tick sites, pick one version from Mist's list for the ticked models, big_bang / serial / canary / rrm rollout; a log of every AP upgrade with its ID) | none: modelled on Switch Site Upgrade | Site · Org | Mist token + org; a token that can make changes to schedule or cancel |
| **SSID Banned / Approved Clients** (makes changes; its own screen: live clients on one SSID, picked by attribute, reviewed, then pushed to the site or org banned list or the approved list; can turn on banned-client blocking for the WLAN) | `ssid-client-lists.js` (pure logic exported and tested) | Site · Org | Mist token + org; a token that can make changes to push |
| **Wi-Fi Clients Export** | `site-wifi-clients.py` | Site · Org | Mist token + org |
| **IP Blocks / IRB Report** | `mist_ip_blocks.py` | Site · Org | Mist token + org |
| **Switch Port Inventory** | `mist_switch_port_inventory.py` | Site · Org | Mist token + org |
| **SSR Pre/Post Check** | `pre-post-check-gui.py` | SSR Conductor | Conductor URL + username/password (opens in its own tab) |


### SSR Pre/Post Check

Snapshot the nine checks across the routers you select, make your change, then
run the post-check to diff every value that moved — with character-level
highlighting on click, and CSV export matching the Python's columns exactly
(Router, Check, Path, Pre Value, Post Value, Change).

It runs in its own tab, `ssr.html`. The Conductor is at an address only you
know, so it cannot be in the Mist-only connection list the toolbox page
enforces; its own page may reach HTTPS hosts and never holds the Mist token.
The Conductor host is not in `host_permissions`. The first time you connect, the
browser asks permission for that one origin.

## Adding a tool

**From the toolbox (no command line):** on the home screen press **Manage tools**
and choose the tool's `.js` file. It is checked before anything is written:
Node or Python scripts, `fetch`, storage, `console.*` and npm imports are
refused with an explanation. A tool that makes changes (it calls
`ctx.mistWrite`, or names POST/PUT/PATCH/DELETE) is allowed, with a strong red
warning, and is labelled **Makes changes** even if it does not declare
`writes: true`. Press **Install**. The first time in a tab you pick the
extension's folder (the one you chose with *Load unpacked*) and allow the
browser to edit it. The file is written to `tools/`, listed in
`tools/tools.json`, and its card appears without reloading, so the token
survives. If the new tool fails to load, both files are put back.

**Removing a tool:** every added tool has a **Remove** button under its card
(and in the Manage tools panel). It deletes the file from `tools/` and takes
it out of `tools/tools.json`. A tool that failed to load can be removed the
same way. The built-in tools have no Remove button.

This works because an unpacked extension is an ordinary folder. The File
System Access API needs no manifest permission, and the folder handle stays in
page memory only. A store-installed (packed) copy cannot be written to; use
the manual route there.

**Writing a tool:** see `docs/TOOL_GUIDE.md` (also linked as *Authoring guide*
in the panel) and start from `docs/tool-template.js` (read-only), or from
`docs/tool-template-writes.js` for a tool that makes changes (dry run, preview,
token check, then `ctx.mistWrite`). To convert an existing
Python or Node script, press **Copy AI prompt**, paste the prompt into an AI
assistant, add your script at the end, and install the file it returns.
`tests/docs.test.js` keeps the guide's `ctx` table and tool keys, the prompt's
rules and both examples in step with the code.



## Layout

```
manifest.json          MV3 manifest: 13 Mist hosts, no permissions array, HTTPS-only CSP
background.js          opens/focuses the toolbox tab; never sees a credential
toolbox.html/.css/.js  the shell: credentials, menu, generated forms, run lifecycle
console.html/.js       the Disconnect Console, v1.4, essentially untouched
ssr.html/.js           the SSR Pre/Post Check's own tab (ssr/ holds the check)
mist.js                Mist transport: one fetch, pooling, 429 backoff, mistWrite
engine/                the disconnect console's correlation engine, DOM-free
lib/
  zip.js               ZIP writer over the platform's CompressionStream
  xlsx.js              styled multi-sheet OOXML, replacing openpyxl/xlsxwriter
  paginate.js          Mist's two pagination regimes
  subnet.js            IPv4/IPv6 math, replacing Python's ipaddress
  junos.js             shlex.split plus the Junos IRB/VLAN parser
  switchports.js       the port inventory's merge rules
  diff.js              flatten/compute_changes plus difflib's SequenceMatcher
  access.js            what the token may do in the selected org, from GET /self
  upgrade.js           org device upgrades shared by Switch and AP Site Upgrade: start time, versions, status, log
  toolcheck.js         the install check: refused rules, and warnings for tools that make changes
  dom.js, download.js  shared rendering and download helpers
tools/
  tools.json           the registry: filenames, one per tool
  registry.js          loader and validator
  *.js                 one file per tool
scripts/scan-tools.mjs regenerates tools.json from the directory
tests/                 node --test, no dependencies
```
