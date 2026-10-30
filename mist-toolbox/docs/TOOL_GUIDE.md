# Writing a Mist Provision Box tool

A tool is **one JavaScript file** that runs inside the browser extension. It
default-exports one object. The toolbox reads that object and builds the menu
card, the settings form, the Run/Cancel buttons, the progress bar, the activity
log, the results preview and the `.xlsx` download for you. A tool only has to
fetch data and shape it into rows.

Fastest route: open `tool-template.js` (next to this guide), copy it, and
change it. It is read-only, which is best practice. For a tool that makes
changes to Mist (provisioning a site, say), start from
`tool-template-writes.js` instead and read section 5 first. Converting an
existing Python or Node script? Use **Copy AI prompt** in the Manage tools
panel. It holds everything in this guide plus both templates, ready to paste
into an AI assistant along with your script.


## 1. It is not a Node or Python script

Tools run in the browser, so these do **not** exist:

| Not available | Use instead |
|---|---|
| `require(...)`, `module.exports` | `import ... from "../lib/x.js"` and `export default {...}` |
| `process.argv`, terminal prompts, `getpass` | `params` (a form the toolbox draws) |
| `process.env.MIST_TOKEN`, token prompts | the token bar at the top of the toolbox; `needs: { mistToken: true }`. Tools never see the token itself |
| `fetch(...)`, `requests.get`, axios | `ctx.getAll(path)` / `ctx.mistGet(path)` |
| `requests.post/put/delete` | `ctx.mistWrite(method, path, body)`, in a tool that declares `writes: true` (section 5) |
| ExcelJS, openpyxl, pandas, `fs.writeFile` | return `sheets` from `run()`; the toolbox writes the `.xlsx` |
| `console.log`, `print` | `ctx.log(message, kind)` |
| npm packages | none, apart from the toolbox's own `../lib/*.js` |

When you install a tool, the toolbox checks it first.

**Refused** (the file is not installed) if it uses `require`,
`module.exports`, `process.*`, `fetch`, `XMLHttpRequest`/`WebSocket`/
`EventSource`/`sendBeacon`, `eval`/`new Function`, dynamic `import()`,
`console.*`, browser storage (`localStorage`, `indexedDB`, `chrome.storage`…),
messages to the service worker, or an import from anywhere other than
`../lib/`, `../engine/` or `../mist.js`.

**Allowed, with a strong warning** if it makes changes: it calls
`ctx.mistWrite`, or names a `POST`, `PUT`, `PATCH` or `DELETE` method. Such a
tool is labelled **Makes changes** on its card and asks for confirmation before
it runs (section 5). Read-only tools are best practice.

The reasons:

- **The token stays on Mist.** Tools are never given the API token. The
  `ctx` helpers add it for you, and only talk to the Mist region the user
  picked, over HTTPS, without cookies. On top of that, the page's security
  policy (CSP) lets nothing on it, by any means, reach a host that is not one
  of the Mist regions in the region list.
- **Nothing is stored.** The token lives in memory for the tab and is wiped
  after 30 idle minutes. Storage could keep it around.
- **Read-only by default.** Every built-in tool only reads, except Switch Site
  Upgrade. A tool that makes changes is allowed, but it is labelled, confirmed
  and warned about.


## 2. The tool object

```js
export default {
  id: "device-count",                 // lowercase letters, digits, dashes; unique
  name: "Device Count by Site",       // card title
  description: "What it does, in a sentence or two.",   // card text (over 30 chars)
  tag: "Mist API",                    // optional small label on the card
  level: "Site · Client",             // optional: overrides the level chip on the card
  notice: "Contains PII …",           // optional banner shown above the form
  needs: { mistToken: true, org: true },
  scope: "site",                      // site picker + "All sites in the org" (see below)
  writes: true,                       // ONLY if it makes changes to Mist (section 5)
  params: [ /* form fields, below */ ],
  async run(ctx) { /* … */ return { /* result, below */ }; },
  // async mount(ctx) { … }          // optional: draw your own view instead of the form
};
```

`needs.mistToken: true` means the card stays locked until a token is
validated. `needs.org: true` means an organization must be selected, and
`ctx.orgId` / `ctx.orgName` are set.

`level` is the small chip on the card (**Site · Org**, **Org**…). It is worked
out for you from `scope` and `needs`; set it only when that would be wrong.

`writes: true` declares that the tool changes Mist configuration. It must be a
boolean. A tool that calls `ctx.mistWrite` or names a write method is labelled
**Makes changes** whether or not it declares this, so declare it honestly:
readers of the file can then see it too. Leave it out for read-only tools.

`mount(ctx)` is for the rare tool that draws its whole view itself (the
Disconnect Console and SSR Pre/Post launchers do). The toolbox then hides the
form and Run button and calls `mount` with `ctx.mount` set. Most tools only
need `run`.

### `scope: "site"`: one site or the whole org

Any report that works across sites should declare `scope: "site"`. The toolbox
then:

- adds two fields above your own: **All sites in the org** (ticked by default)
  and a **Site** picker, which is greyed out while the box is ticked. Don't
  declare `allSites` or `siteId` params yourself; a scoped tool that does is
  refused.
- labels the menu card **Site · Org**. Org-only tools show **Org**.
- gives you `await ctx.targetSites()`, which returns:

| Field | What it is |
|---|---|
| `sites` | The sites to report on: every site, or just the chosen one. Full Mist site records, sorted by name |
| `orgSites` | Every site in the org, for looking up names by `site_id` |
| `all` | `true` when "All sites in the org" is ticked |
| `label` | `"all 42 sites"` or the site's name, for log lines and summaries |
| `fileLabel` | `"<org>"` or `"<org>_<site>"`. Use it in `ctx.stampedName(prefix, scope.fileLabel, ext)` |

Loop over `sites` instead of fetching `/orgs/{id}/sites` yourself. If you need an
org-wide call (inventory, say), filter its rows to `sites` by `site_id`.

### `params`: the form

Each entry draws one field. Its value arrives as `ctx.params.<id>`.

| `type` | Field | Value in `ctx.params` |
|---|---|---|
| `text` (default) | text box | string |
| `password` | hidden text box | string |
| `number` | number box | number, or `null` if blank |
| `checkbox` | checkbox | `true` / `false` |
| `select` | dropdown; `options: ["a","b"]` or `[{value, label}]` | string |
| `textarea` | multi-line box | string |
| `file` | file picker | a `File` (`await f.text()`), or `null` |

Other keys: `label`, `default`, `hint` (small text under the field),
`placeholder`, `full: true` (full-width). A `select` with
`optionsFrom: "sites"` fills itself with the org's sites (value = site id).
`optionsFrom: "orgs"` lists the token's orgs.


## 3. `ctx`: what `run()` receives

| Key | What it is |
|---|---|
| `ctx.host` | Mist API host, e.g. `api.gc2.mist.com`. There is no `ctx.token`: tools are never given the token, the helpers below add it |
| `ctx.orgId` | Selected org id |
| `ctx.orgName` | Selected org name |
| `ctx.orgs` | Every org the token can see: `[{id, name}]` |
| `ctx.params` | Form values, keyed by param `id` |
| `ctx.signal` | `AbortSignal`, set when the user presses Cancel. Check `ctx.signal.aborted` in loops |
| `ctx.mount` | A DOM element below the form, for tools that draw their own view |
| `ctx.access` | What the token may do in the selected org: `{ level, canWrite, label, roles, detail }`. `level` is `"read"`, `"limited"`, `"write"`, `"admin"` or `"unknown"`, e.g. `label: "Read-only token (Observer)"` |
| `ctx.mistGet` | `await ctx.mistGet(path, params?)` returns the parsed JSON of one GET |
| `ctx.mistGetFull` | Same, but returns `{data, headers}` |
| `ctx.getAll` | `await ctx.getAll(path, params?)` follows every page and returns one array. Handles both Mist pagination styles. **Use this for lists.** |
| `ctx.searchAll` | Same for `/search` endpoints (follows the `next` cursor) |
| `ctx.mistWrite` | `await ctx.mistWrite(method, path, body?, params?)` sends one change (`"POST"`, `"PUT"`, `"PATCH"` or `"DELETE"`) and returns the parsed reply. Only for tools labelled **Makes changes**; never retried; each call is logged. See section 5 |
| `ctx.listSites` | `await ctx.listSites()` returns every site in the org as `{id, name}`, sorted |
| `ctx.targetSites` | For `scope: "site"` tools: `await ctx.targetSites()` returns the sites the user chose (see above) |
| `ctx.pool` | `await ctx.pool(limit, [() => promise, …])` runs jobs in parallel, results in input order |
| `ctx.POOL_LIMIT` | Polite parallelism for Mist (6) |
| `ctx.xlsx` | `{ sheet, workbook, STYLE, colLetter }`. Usually you only need `sheet` |
| `ctx.download` | `ctx.download(blob, filename)` saves any file to the downloads folder |
| `ctx.stampedName` | `ctx.stampedName("prefix", ctx.orgName, "xlsx")` gives `prefix_Org_20261008_141500.xlsx` |
| `ctx.safeName` | Makes a string safe as a filename |
| `ctx.toCsv` | `ctx.toCsv(headerArray, rowArrays)` returns CSV text |
| `ctx.log` | `ctx.log(message, kind)`. `kind` is `"info"`, `"ok"` or `"err"` |
| `ctx.progress` | `ctx.progress(done, total, label)` drives the progress bar |
| `ctx.status` | `ctx.status(text)` sets the short status beside Run |
| `ctx.esc` | HTML-escapes a value. Required for anything you put in `innerHTML` |
| `ctx.previewTable` | `ctx.previewTable(columns, rows, limit)` returns an HTML table |
| `ctx.fmtMac` | `"aabbccddeeff"` becomes `"aa:bb:cc:dd:ee:ff"` |
| `ctx.fmtTime` | Epoch (s or ms) to a local date-time string |
| `ctx.epochToUtc` | Epoch to `"2026-10-08 14:15:00 UTC"` |
| `ctx.fmtBytes` | `1536` becomes `"1.5 KB"` |

Paths are relative to `/api/v1`, e.g. `ctx.getAll(`/orgs/${ctx.orgId}/sites`)`.
Booleans in `params` are sent as the strings `"true"`/`"false"`, which is what
Mist expects. A non-2xx response throws an `Error` whose message says what
happened. Catch it per site if one failing site shouldn't stop the report.


## 4. What `run()` returns

```js
return {
  summary: "42 switches across 7 sites",           // shown above the preview
  filename: ctx.stampedName("mist_switches", ctx.orgName, "xlsx"),
  sheets: [
    ctx.xlsx.sheet("Switches", columns, rows, { tabColor: "1F4E78" }),
    ctx.xlsx.sheet("Info", [{ header: "Field" }, { header: "Value" }],
                   [["Org", ctx.orgName]], { autofilter: false, freeze: null }),
  ],
  preview: { title: "Switches", columns, rows },  // on-screen table (first 200 rows)
  files: [{ name: "extra.csv", blob }],           // optional extra download buttons
};
```

- **columns**: `[{ header: "Site", key: "site", width?: 20, wrap?: true }]`.
  Widths are automatic if left out.
- **rows**: objects keyed by column `key`, or plain arrays in column order. A
  row can carry `__style: "bold" | "green" | "yellow" | "red" | "blue"` to
  colour the whole row.
- Every sheet gets the house style automatically: dark blue bold header,
  frozen header row, autofilter, sized columns. Text that starts with `=` is
  stored as text, never as a formula.
- If `sheets` is present, the `.xlsx` downloads as soon as `run()` returns.
  The Download button stays for repeat saves.

Throw an `Error` to fail the run. Its message is shown to the user.


## 5. Tools that make changes

Read-only tools are best practice: they cannot break anything, and they work
with a read-only (Observer) token. Write a tool that makes changes only when
the job needs it, such as provisioning a site. Then:

1. **Declare it.** `writes: true` on the tool object.
2. **Send changes with `ctx.mistWrite(method, path, body)`.** It uses the same
   Mist-only request path as the read helpers. It is never retried (so a change
   is never applied twice), a `403` says the token is not allowed to make the
   change, and every call is written to the activity log.
3. **Plan, preview, then apply.** Add a `dryRun` checkbox param that defaults to
   `true`. Work out the full list of changes first, show it with
   `ctx.previewTable` (or return it as a sheet), and only call `ctx.mistWrite`
   when `dryRun` is off.
4. **Check the token first.** If `ctx.access.canWrite` is `false`, Mist will
   refuse the changes. Stop early with a clear message, or run the dry run only.
5. **Log every change** with `ctx.log`, and return a sheet of what was changed.

What the user sees for such a tool:

- a red **Makes changes** chip on its card (other tools show **Read-only**);
- a red banner above its form, which also says when their token is read-only
  for this org;
- a confirmation, naming the org and their token's permission, before it runs;
- at install time, a strong warning in the Manage tools check. The install is
  still allowed.

A complete example: `tool-template-writes.js`, next to this guide.


## 6. Installing

**From the toolbox:** home screen, **Manage tools**, choose the `.js`. If the
check passes, press **Install**. A tool that makes changes shows a strong red
warning in the check; read it, then Install if you mean to. The first time in
a tab you pick the extension's folder (the one chosen with *Load unpacked*)
and allow the browser to edit it. The file is written to `tools/`, listed in
`tools/tools.json`, and the card appears straight away. If the new tool fails
to load, both files are put back as they were.

**Removing:** every tool you added has a **Remove** button under its card on
the home screen, and is listed in the Manage tools panel with the same button.
Removing deletes the file from `tools/` and takes it out of `tools/tools.json`.
Built-in tools have no Remove button and cannot be removed.

**By hand:** copy the file into `tools/`, run `npm run scan` (or add the
filename to `tools/tools.json`), and reload the extension on
`chrome://extensions` / `edge://extensions`.


## 7. Testing (optional, needs Node 18+)

```bash
npm test     # every tool in tools.json must load and pass the policy checks
```

To test a tool's logic against fake Mist data, see `tests/ssid-report.test.js`.
`stubMist({ "/orgs/org-1/sites": [...] })` answers requests from a table, and
`testCtx()` gives your `run()` the same `ctx` the toolbox does. For a tool that
makes changes, `testCtx({ role: "write" })` sets `ctx.access`, and every
`ctx.mistWrite` call is recorded in `ctx.writes` so a test can check exactly
what would be sent.
