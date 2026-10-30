# Convert a script into a Mist Provision Box tool

You are converting a script (Python, Node.js, PowerShell, or anything else) into a
**Mist Provision Box tool**: one ES-module JavaScript file that runs inside a Chrome/Edge
extension. Read all of the rules below, then convert the script pasted at the end.

**Read-only is the default and best practice.** Make a tool that changes Mist
configuration only if the script being converted changes configuration, or the user
explicitly asks for changes. Then follow "Tools that make changes" below.

## What a tool is

The file default-exports one object. The toolbox draws the menu card, a form from
`params`, Run/Cancel, a progress bar, an activity log, an on-screen preview, and
writes the `.xlsx` download itself. The tool only fetches data and shapes rows.

```js
export default {
  id: "kebab-case-id",          // lowercase letters, digits, dashes
  name: "Human Name",
  description: "One or two sentences (more than 30 characters) saying what the report contains.",
  tag: "Mist API",
  needs: { mistToken: true, org: true },   // token + selected org are supplied by the toolbox
  scope: "site",                            // adds "All sites in the org" + a Site picker
  writes: true,                             // ONLY for a tool that makes changes; omit otherwise
  params: [ /* form fields */ ],
  async run(ctx) { /* ... */ return { summary, filename, sheets, preview }; },
};
```

`params` entries: `{ id, label, type, default, hint, options, optionsFrom }` where
`type` is one of `text`, `password`, `number`, `checkbox`, `select`, `textarea`, `file`.
Values arrive as `ctx.params.<id>` (number → number or null, checkbox → boolean,
file → File or null). A `select` with `optionsFrom: "sites"` lists the org's sites
(value = site id).

**Site / org scope.** Any report that covers sites must declare `scope: "site"`. The toolbox
then draws an "All sites in the org" checkbox and a Site picker (never declare `allSites` /
`siteId` params yourself), and `await ctx.targetSites()` returns
`{ sites, orgSites, all, label, fileLabel }`. `sites` holds the full site records to report
on (one, or all), `orgSites` every site for name lookups, and `fileLabel` goes into
`ctx.stampedName(prefix, scope.fileLabel, "xlsx")`. Loop over `sites` instead of fetching
`/orgs/{id}/sites`; filter org-wide calls (e.g. inventory) to those sites by `site_id`.

## The `ctx` object `run()` receives

- `ctx.host`, `ctx.orgId`, `ctx.orgName`, `ctx.orgs`, `ctx.params`, `ctx.signal` (AbortSignal for Cancel)
- There is **no `ctx.token`**. Tools never see the token; the helpers below add it.
- `ctx.access` → what the token may do in this org: `{ level, canWrite, label, roles, detail }`, `level` one of `"read"`, `"limited"`, `"write"`, `"admin"`, `"unknown"`.
- `await ctx.getAll(path, params?)` → array; follows **all** Mist pagination. Use for every list endpoint.
- `await ctx.mistGet(path, params?)` → parsed JSON of one GET. `ctx.mistGetFull` → `{data, headers}`.
- `await ctx.searchAll(path, params?)` → array, for `/search` endpoints.
- `await ctx.mistWrite(method, path, body?, params?)` → sends one change (`"POST"`, `"PUT"`, `"PATCH"`, `"DELETE"`), returns the parsed reply. Only for tools with `writes: true`. Never retried; a 403 means the token may not make the change.
- Paths are relative to `/api/v1`, e.g. `` `/orgs/${ctx.orgId}/sites` ``. Non-2xx throws an Error.
- `await ctx.pool(ctx.POOL_LIMIT, jobs)` — run an array of `() => promise` with limited parallelism; results keep input order.
- `ctx.log(msg, "info" | "ok" | "err")`, `ctx.progress(done, total, label)`, `ctx.status(text)`
- `ctx.xlsx.sheet(name, columns, rows, opts?)` — columns `[{header, key, width?, wrap?}]`; rows are objects keyed by `key` (or arrays). Row `__style: "bold"|"green"|"yellow"|"red"|"blue"` colours a row. opts: `{ tabColor: "1F4E78", autofilter: false, freeze: null }`.
- `ctx.stampedName(prefix, ctx.orgName, "xlsx")` → timestamped filename.
- `ctx.download(blob, name)`, `ctx.toCsv(headerArray, rowArrays)`, `ctx.esc(s)` (HTML-escape)
- `ctx.fmtMac`, `ctx.fmtTime(epoch)`, `ctx.epochToUtc(epoch)`, `ctx.fmtBytes(n)`

`run()` returns `{ summary, filename, sheets: [ctx.xlsx.sheet(...)], preview: { title, columns, rows } }`.
Header styling, frozen header, autofilter and column widths are applied automatically.
Throw an `Error` to fail with a message.

## Hard rules — the toolbox refuses files that break them

1. **No Node or Python APIs**: no `require`, `module.exports`, `process.*`, `__dirname`, `fs`, `readline`, no npm packages.
2. **No direct network**: no `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`, axios. Read with `ctx.getAll` / `ctx.mistGet` / `ctx.searchAll`; change with `ctx.mistWrite`. The page's security policy blocks every host except the Mist regions anyway.
3. **Read-only by default**: GET through the ctx helpers. POST/PUT/PATCH/DELETE are **allowed only through `ctx.mistWrite`** in a tool that declares `writes: true` and follows "Tools that make changes" below. The toolbox warns strongly about such a tool at install, labels it "Makes changes", and asks the user to confirm before it runs.
4. **No storage**: no `localStorage`, `sessionStorage`, `indexedDB`, `chrome.storage`, cookies.
5. **No `console.*`** — use `ctx.log`. **No `eval` / `new Function` / dynamic `import()`.** No `chrome.runtime.sendMessage` / `connect`.
6. **Imports**: only `../lib/*.js`, `../engine/*.js`, `../mist.js` — normally you need none.
7. **No token handling**: never prompt for, read from env, hardcode, or use `ctx.token` (it does not exist). The toolbox supplies the token and region.
8. **Do not write files**; return `sheets` and the toolbox builds the `.xlsx`.

## Tools that make changes

Only when the script changes Mist configuration, or the user asks for changes:

- Declare `writes: true`.
- Add a `dryRun` checkbox param with `default: true`. Build the complete list of changes first, return it as a sheet and `preview`, and send nothing while `dryRun` is ticked.
- Before sending, check `ctx.access.canWrite`; if it is false, throw an Error that says the token cannot make changes and that nothing was sent.
- Send each change with `await ctx.mistWrite(method, path, body)`, one at a time, with `try/catch` per item so one failure is recorded and the rest continue. `ctx.log` every change.
- Return a sheet of what was changed (or planned), with the before and after values.
- State plainly in `description` what the tool changes.

## Conversion guidance

- Keep the original's API calls, row fields, column headers, column order, sorting and filename prefix.
- If the original loops over an org's sites (or takes a site as an argument), make it `scope: "site"` and use `ctx.targetSites()`.
- Terminal prompts and command-line flags become `params`. Hardcoded org/region choices go away (the toolbox supplies them).
- Replace hand-written pagination with `ctx.getAll` (Mist can return fewer rows than `limit` before the end; `getAll` handles it).
- Sequential per-site loops become `ctx.pool(ctx.POOL_LIMIT, ...)`, with a `try/catch` per site so one failure is logged and reported in `summary` rather than fatal. Call `ctx.progress` as sites finish.
- Spreadsheet styling code (header fills, freeze panes, autofilter, widths) is dropped — it is automatic.
- Export small pure helper functions with `export function` so they can be unit-tested.

## Output

Reply with **one complete JavaScript file and nothing else** — no explanation before or after,
no Markdown other than a single ```js fence. Choose a kebab-case filename and put it in a
first-line comment, e.g. `// mist-switch-report.js — converted from mist_switch_report.js`.

## A complete, working example tool (read-only — the default)

```js
// A complete, working Mist Provision Box tool to copy from.
//
// It counts the devices at one site, or at every site, from one org inventory
// call. `scope: "site"` gives it the site picker and the "All sites in the
// org" box; ctx.targetSites() says which sites were chosen. Rename the
// file (e.g. my-report.js), change id / name / description, replace run(), and
// install it with the toolbox's "Manage tools" button.
//
// It only reads, which is best practice. For a tool that makes changes to Mist,
// start from tool-template-writes.js instead.

export default {
  id: "device-count",
  name: "Device Count by Site",
  description: "How many access points, switches and gateways one site, or every site "
    + "in the org, has — from the org inventory, with a total row.",
  tag: "Mist API",
  needs: { mistToken: true, org: true },
  scope: "site",
  params: [
    {
      id: "connectedOnly",
      label: "Count connected devices only",
      type: "checkbox",
      default: false,
    },
  ],

  async run(ctx) {
    const { getAll, log } = ctx;
    log(`Org: ${ctx.orgName}`, "info");

    const scope = await ctx.targetSites();
    const siteName = Object.fromEntries(scope.orgSites.map((s) => [s.id, s.name || s.id]));
    const wanted = new Set(scope.sites.map((s) => s.id));
    log(`Scope: ${scope.label}`, "info");

    // The inventory call is org-wide; keep the chosen sites (and, for the
    // whole org, devices not yet assigned to any site).
    const inventory = (await getAll(`/orgs/${ctx.orgId}/inventory`))
      .filter((d) => wanted.has(d.site_id) || (scope.all && !d.site_id));
    const counted = ctx.params.connectedOnly ? inventory.filter((d) => d.connected) : inventory;
    log(`${counted.length} device(s) counted of ${inventory.length} in inventory.`, "info");

    const bySite = new Map();
    for (const d of counted) {
      const key = d.site_id || "";
      const row = bySite.get(key) || { site: siteName[key] || "(unassigned)", ap: 0, switch: 0, gateway: 0 };
      if (d.type in row) row[d.type] += 1;
      bySite.set(key, row);
    }
    const rows = [...bySite.values()].sort((a, b) => a.site.localeCompare(b.site));
    rows.push({
      site: "Total",
      ap: rows.reduce((n, r) => n + r.ap, 0),
      switch: rows.reduce((n, r) => n + r.switch, 0),
      gateway: rows.reduce((n, r) => n + r.gateway, 0),
      __style: "bold",
    });

    const columns = [
      { header: "Site", key: "site" },
      { header: "Access Points", key: "ap" },
      { header: "Switches", key: "switch" },
      { header: "Gateways", key: "gateway" },
    ];

    log("Done.", "ok");
    return {
      summary: `${counted.length} device(s) across ${rows.length - 1} site(s)`,
      filename: ctx.stampedName("mist_device_count", scope.fileLabel, "xlsx"),
      sheets: [ctx.xlsx.sheet("Devices by Site", columns, rows)],
      preview: { title: "Devices by Site", columns, rows },
    };
  },
};
```

## A complete, working example of a tool that makes changes

Use this pattern only when changes are needed.

```js
// A complete, working tool that MAKES CHANGES to Mist, to copy from.
//
// Read-only tools are best practice; start from tool-template.js unless the
// job really needs to change configuration. This one sets the Notes field of
// one site, or of every site, and shows the pattern every tool that makes
// changes should follow:
//
//   1. writes: true             declares it; the card says "Makes changes"
//   2. a Dry run box, ticked    plan and preview first, change nothing
//   3. check ctx.access         stop early if the token cannot make changes
//   4. ctx.mistWrite            the only way to send a change; logged, never retried
//   5. a sheet of what changed  so the run leaves a record
//
// Mist endpoints: GET /orgs/{org_id}/sites (through ctx.targetSites),
// PUT /sites/{site_id} with { notes }.

export default {
  id: "site-notes",
  name: "Site Notes",
  description: "Sets the Notes field of one site, or of every site in the org. Runs as a "
    + "dry run first, so you can see every change before anything is sent.",
  tag: "Mist API",
  needs: { mistToken: true, org: true },
  scope: "site",
  writes: true,
  params: [
    { id: "notes", label: "Notes", type: "textarea", full: true,
      hint: "The text to put in each site's Notes field." },
    { id: "mode", label: "How", type: "select", default: "replace",
      options: [
        { value: "replace", label: "Replace the existing notes" },
        { value: "append", label: "Add to the end of the existing notes" },
      ] },
    { id: "dryRun", label: "Dry run: show the changes, send nothing", type: "checkbox", default: true },
  ],

  async run(ctx) {
    const { log, params } = ctx;
    const text = String(params.notes || "").trim();
    if (!text) throw new Error("Enter the notes to set.");

    const scope = await ctx.targetSites();
    log(`Scope: ${scope.label}`, "info");

    // 1. Plan: work out every change before sending any.
    const plan = scope.sites.map((s) => {
      const before = String(s.notes || "");
      const after = params.mode === "append" && before ? `${before}\n${text}` : text;
      return { id: s.id, site: s.name || s.id, before, after, action: before === after ? "No change" : "Update" };
    });
    const changes = plan.filter((p) => p.action === "Update");
    log(`${changes.length} of ${plan.length} site(s) would change.`, "info");

    // 2. Dry run, or a token that cannot make changes: stop after the plan.
    let applied = false;
    if (params.dryRun) {
      log("Dry run: nothing was sent. Untick Dry run to apply.", "info");
    } else if (!ctx.access?.canWrite) {
      throw new Error(`Your token cannot make changes in this org (${ctx.access?.label || "permission unknown"}). `
        + "Nothing was sent.");
    } else {
      // 3. Apply, one site at a time, recording each result.
      for (const p of changes) {
        if (ctx.signal.aborted) break;
        try {
          await ctx.mistWrite("PUT", `/sites/${p.id}`, { notes: p.after });
          p.action = "Updated";
          log(`${p.site}: notes updated`, "ok");
        } catch (e) {
          p.action = `Failed: ${e.message}`;
          log(`${p.site}: ${e.message}`, "err");
        }
      }
      applied = true;
    }

    const columns = [
      { header: "Site", key: "site", width: 30 },
      { header: "Result", key: "action", width: 24 },
      { header: "Notes before", key: "before", width: 50, wrap: true },
      { header: "Notes after", key: "after", width: 50, wrap: true },
    ];
    const rows = plan.map((p) => ({
      ...p,
      __style: p.action.startsWith("Failed") ? "red" : p.action === "Updated" ? "green"
        : p.action === "Update" ? "yellow" : undefined,
    }));
    const done = plan.filter((p) => p.action === "Updated").length;
    return {
      summary: applied
        ? `${done} of ${changes.length} site(s) updated`
        : `Dry run: ${changes.length} of ${plan.length} site(s) would be updated`,
      filename: ctx.stampedName(applied ? "mist_site_notes_applied" : "mist_site_notes_plan", scope.fileLabel, "xlsx"),
      sheets: [ctx.xlsx.sheet(applied ? "Changes" : "Planned Changes", columns, rows)],
      preview: { title: applied ? "Changes" : "Planned changes (dry run)", columns, rows },
    };
  },
};
```

--- PASTE YOUR SCRIPT BELOW THIS LINE ---

