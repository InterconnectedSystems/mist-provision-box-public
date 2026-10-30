// The SSR tool's terminal view: Conductor JSON laid out like CLI output, CLI
// text kept verbatim, and post-check changes marked field by field.

import { strict as assert } from "node:assert";
import test from "node:test";

import { changedLines, cleanText, diffText, fieldDiff, toCliText } from "../lib/cliview.js";
import { charDiff } from "../lib/diff.js";

const BGP = {
  ipv4Unicast: {
    routerId: "10.0.0.1", as: 65001,
    peers: {
      "10.1.1.1": { remoteAs: 65002, state: "Established", pfxRcd: 120 },
      "10.1.1.2": { remoteAs: 65003, state: "Established", pfxRcd: 80 },
    },
  },
};

test("a BGP peers map renders as an aligned neighbor table", () => {
  const lines = toCliText(BGP).split("\n");
  assert.deepEqual(lines, [
    "ipv4Unicast:",
    "  routerId  10.0.0.1",
    "  as        65001",
    "",
    "  peers:",
    "    name      remoteAs  state        pfxRcd",
    "    --------  --------  -----------  ------",
    "    10.1.1.1  65002     Established  120",
    "    10.1.1.2  65003     Established  80",
  ]);
});

test("CLI text is kept verbatim, minus CRLF, colour codes and trailing blanks", () => {
  const raw = "Neighbor  V  AS\r\n10.1.1.1  4  65002\r\n\u001b[32mUp\u001b[0m\r\n\r\n";
  assert.equal(toCliText(raw), "Neighbor  V  AS\n10.1.1.1  4  65002\nUp");
  assert.equal(toCliText({ output: "a\nb" }), "a\nb", "a one-field wrapper around text shows just the text");
  assert.equal(cleanText("x\ty  \n"), "x\ty");
});

test("lists of records become tables; per-node checks get node banners", () => {
  const text = toCliText({ "node-a": [{ name: "ge-0", state: "up" }, { name: "ge-1", state: "down" }] }, { perNode: true });
  assert.deepEqual(text.split("\n"), [
    "==== Node: node-a ====",
    "name  state",
    "----  -----",
    "ge-0  up",
    "ge-1  down",
  ]);
  assert.equal(toCliText([]), "(none)");
  assert.equal(toCliText(null), "-");
});

test("post-check changes are marked per field, only in the changed line", () => {
  const post = structuredClone(BGP);
  post.ipv4Unicast.peers["10.1.1.2"].state = "Active";
  post.ipv4Unicast.peers["10.1.1.2"].pfxRcd = 0;
  const rows = diffText(toCliText(BGP), toCliText(post));
  const changed = rows.filter((r) => r.kind !== "same");
  assert.equal(changed.length, 1);
  assert.equal(changedLines(rows), 1);
  const hot = changed[0].post.filter(([, h]) => h).map(([t]) => t);
  assert.deepEqual(hot, ["Active", "0"], "only the fields that moved light up");
  assert.ok(changed[0].post.some(([t, h]) => !h && t.includes("10.1.1.2")), "the neighbor itself is unchanged");
});

test("re-padding from a wider column is not a change", () => {
  const post = structuredClone(BGP);
  post.ipv4Unicast.peers["10.1.1.2"].state = "Established-Long";
  const rows = diffText(toCliText(BGP), toCliText(post));
  // The header, rule and other peer re-pad; only the edited line counts.
  assert.equal(changedLines(rows), 1);
});

test("added and removed lines are reported as such", () => {
  const rows = diffText("a\nb\nc", "a\nc\nd");
  assert.deepEqual(rows.map((r) => r.kind), ["same", "removed", "same", "added"]);
  assert.equal(diffText("", "x")[0].kind, "added");
});

test("fieldDiff keeps the original spacing", () => {
  const [, post] = fieldDiff("ge-0   up    1", "ge-0   down  1");
  assert.equal(post.map(([t]) => t).join(""), "ge-0   down  1");
  assert.deepEqual(post.filter(([, h]) => h).map(([t]) => t), ["down"]);
});

test("charDiff does not split characters outside the BMP", () => {
  const [pre, post] = charDiff("a😀b", "a😀c");
  assert.equal(pre.map(([t]) => t).join(""), "a😀b");
  assert.equal(post.map(([t]) => t).join(""), "a😀c");
  assert.deepEqual(post.filter(([, h]) => h).map(([t]) => t), ["c"]);
});
