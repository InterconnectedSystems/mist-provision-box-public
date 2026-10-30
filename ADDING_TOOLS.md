# Adding your own tools

Mist Provision Box is **additive**. The tools it ships with are a starting point, and anyone can add
more without touching the extension's code. A tool is **one JavaScript file**. The toolbox
supplies everything else:

- the menu card;
- the token, region and org selection;
- the site picker with "All sites in the org";
- the settings form, Run/Cancel, progress bar and activity log;
- the on-screen preview and the styled `.xlsx` download.

You don't need to write that file yourself. The extension **ships its own LLM spec**,
[`TOOL_PROMPT.md`](mist-toolbox/docs/TOOL_PROMPT.md). It is a ready-made prompt that teaches any
AI assistant (Claude, ChatGPT, Copilot, Gemini…) the tool format, the helpers available, the
security rules, and two complete working examples: a read-only report (the default, and best
practice) and a tool that makes changes. Paste the prompt, paste the script or describe
the report you want, and the assistant returns a file you can install.

```
 your script or idea ─┐
                      ├─► AI assistant ─► my-report.js ─► Manage tools → Install ─► new tool card
 TOOL_PROMPT.md ──────┘    (any LLM)
```

## Step by step

### 1. Copy the AI prompt

Open the toolbox, press **Manage tools** (under the tool cards), then **Copy AI prompt**.

![Manage tools → Copy AI prompt](mist-toolbox/docs/screenshots/17-manage-copy-prompt.png)

You can also read it, copy it or download it from the docs viewer (**Authoring guide** → *AI
prompt*), or take it straight from GitHub: [`mist-toolbox/docs/TOOL_PROMPT.md`](mist-toolbox/docs/TOOL_PROMPT.md).

![TOOL_PROMPT.md in the docs viewer](mist-toolbox/docs/screenshots/15-ai-prompt-top.png)

### 2. Paste it into an AI assistant, then add your script

Start a new chat and paste the prompt. It ends with a marker line; put your script, or a plain
description of the report you want, underneath it:

![The end of the prompt: paste your script below the line](mist-toolbox/docs/screenshots/16-ai-prompt-paste-slot.png)

Things you can paste below the line:

- an existing **Python, Node.js or PowerShell** script that calls the Mist API;
- a **description**, e.g. *"For each site, list every AP with its name, model, firmware and
  uptime, and flag APs that have been offline more than a day."*;
- a **Mist API doc snippet** for the endpoint you want to report on.

The assistant replies with a single JavaScript file. Save it with a short name ending in `.js`,
such as `ap-firmware.js`.

> The prompt tells the assistant to keep your script's API calls, columns and sorting, to use
> the toolbox's site picker for anything that covers sites, and to follow the security rules
> below. If the toolbox rejects the file, paste the error message back to the assistant and ask
> it to fix the file.

### 3. Install it

In **Manage tools**, drop the `.js` file on the box (or click to choose it). The file is checked
before anything is written. A file that breaks a rule is turned away with the reason; this is
what happens with a Node script that was not converted:

![A Node script is explained, not installed](mist-toolbox/docs/screenshots/14-manage-tools.png)

A file that passes shows the tool's name and the filename it will install as. A tool that makes
changes to Mist also shows a strong red **Makes changes** warning: read the file before you
install it. The install is still allowed.

![The AI's file passes the check](mist-toolbox/docs/screenshots/18-manage-check-passed.png)

Press **Install**. The first time in a tab, the browser asks you to pick a folder: choose the
extension folder you loaded with *Load unpacked*, and allow the browser to edit it. The file is
written into its `tools/` folder and listed in `tools/tools.json`. The new card
appears straight away, without reloading the extension, so your token stays signed in.

![Installed](mist-toolbox/docs/screenshots/19-manage-installed.png)

### 4. Use it

The new tool sits in the menu with the others, marked **added**, with its own **Remove** button:

![The added tool's card](mist-toolbox/docs/screenshots/20-home-added-tool.png)

It runs like a built-in tool, with the same site picker, progress, preview and `.xlsx` download:

![The added tool running](mist-toolbox/docs/screenshots/21-added-tool-run.png)

### Removing a tool

Press **Remove** under its card, or in **Manage tools → Added tools**. The file is deleted from
`tools/` and taken out of `tools/tools.json`. Built-in tools cannot be removed.

## The rules every tool follows

The checker applies these before installing, and the AI prompt teaches them.

**Refused**: the file is not installed.

| Rule | Why |
|---|---|
| No `require`, `process`, `fs` or npm packages | Tools run in the browser, not in Node |
| No direct `fetch` / `XMLHttpRequest` / `WebSocket` / `sendBeacon` | All Mist calls go through the `ctx` helpers, which only talk to the Mist region you picked |
| No browser storage or cookies | Nothing, especially the token, is ever saved |
| No `console.*`, `eval` or dynamic `import()` | Progress goes to the activity log; the extension's security policy forbids the rest |

**Allowed, with a strong warning**: the file installs, but you are told plainly.

| What | What you see |
|---|---|
| Makes changes to Mist (`POST`/`PUT`/`PATCH`/`DELETE`, through `ctx.mistWrite`) | A red warning when you install it, a **Makes changes** label on its card, a red banner above its form, and a confirmation before every run |

Read-only tools are best practice.

**Your API token stays on Mist.** Tools are never given the token: the `ctx` helpers add it for
them. On top of that, the page's security policy lets nothing on it reach any host except the Mist
regions in the region list. A tool cannot send the token anywhere else, even one written to try.

The check catches mistakes, not deliberate tricks. A tool runs with access to your Mist session,
and a tool that makes changes can change your network, so only install tools you wrote or got
from people you trust.

## Tools that make changes

Provisioning a site, renaming devices, setting site notes: some jobs need to change Mist, not
just read it. The toolbox allows that, but never quietly:

- **The tool says so.** It declares `writes: true`, and its card shows **Makes changes**. A tool
  that sends changes without declaring it is labelled anyway.
- **You see what your token can do.** After you validate a token, the badge next to the
  Organization picker shows its permission for the selected org (for example
  *Read-only token (Observer)* or *Can make changes (Network Admin)*), and updates when you switch
  org. Best practice is a read-only Observer token unless you are about to run a tool that makes
  changes.
- **You confirm before it runs.** The confirmation names the org and your token's permission. If
  your token is read-only for the org, the tool's page tells you Mist will refuse its changes.
- **A good one does a dry run first.** The example
  [`tool-template-writes.js`](mist-toolbox/docs/tool-template-writes.js) shows the pattern: a
  *Dry run* box ticked by default, a preview of every planned change, a check of the token's
  permission, and a sheet recording what was changed.

## Writing tools by hand

The full reference is the [authoring guide](mist-toolbox/docs/TOOL_GUIDE.md): every `ctx`
helper, the form field types, the `scope: "site"` option, tools that make changes, and the result
format. Working starting points are [`tool-template.js`](mist-toolbox/docs/tool-template.js)
(read-only) and [`tool-template-writes.js`](mist-toolbox/docs/tool-template-writes.js) (makes
changes). Without the
**Manage tools** button: copy the file into `mist-toolbox/tools/`, run `npm run scan` (or add
its filename to `tools/tools.json`), and reload the extension.
