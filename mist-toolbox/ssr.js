// The SSR Pre/Post Check in its own tab.
//
// It talks to a Juniper SSR Conductor at a host only the user knows, which no
// fixed connect-src list can name. Giving it a page of its own keeps the
// toolbox page, where the Mist token lives, locked to the Mist regions, while
// this page (which never sees a Mist token) may reach the Conductor the user
// grants. The tool itself is unchanged: it renders into a mount point and uses
// a handful of output helpers.

import { download, stampedName, toCsv } from "./lib/download.js";
import { $, esc } from "./lib/dom.js";
import tool from "./ssr/ssr-pre-post.js";

$("toolName").textContent = tool.name;
$("toolDesc").textContent = tool.description;

try {
  await tool.mount({ mount: $("toolHost"), esc, download, stampedName, toCsv });
} catch (e) {
  $("err").textContent = e.message || String(e);
  $("err").classList.remove("hidden");
}
