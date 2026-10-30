// Shows one of the shipped docs as plain text. A bare .md link may download
// rather than display, so the toolbox links here instead.

import { download } from "../lib/download.js";

const DOCS = new Set(["TOOL_GUIDE.md", "TOOL_PROMPT.md", "tool-template.js", "tool-template-writes.js"]);

const name = new URLSearchParams(location.search).get("doc");
const doc = DOCS.has(name) ? name : "TOOL_GUIDE.md";
const pre = document.getElementById("doc");
document.getElementById("docTitle").textContent = doc;
document.title = `${doc} — Mist Provision Box`;

const text = await fetch(doc, { cache: "no-store" }).then((r) => r.text(), (e) => `Could not load ${doc}: ${e.message}`);
pre.textContent = text;

document.getElementById("btnCopy").onclick = async () => {
  const btn = document.getElementById("btnCopy");
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copied";
  } catch {
    btn.textContent = "Copy failed — select the text";
  }
  setTimeout(() => { btn.textContent = "Copy"; }, 2000);
};

document.getElementById("btnDownload").onclick = () => {
  const type = doc.endsWith(".md") ? "text/markdown" : "text/javascript";
  download(new Blob([text], { type }), doc);
};
