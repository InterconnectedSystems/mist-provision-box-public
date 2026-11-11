// lib/junos-shell.js: the read-only gate, the shell protocol and the Junos
// JSON parsing, plus the openDeviceShell transport in mist.js.
//
// The fixtures are cut down from a real EX4400 `show interfaces extensive …
// | display json` reply (Junos 24.4), with the names, addresses and dates
// replaced and a few error counters set non-zero. The transcript is the same
// JSON as the switch sends it over the shell: CRLF line ends, NUL bytes
// scattered through it, the echoed command, then "{master:0}" and the prompt.

import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ShellSession, asList, cleanTerminal, extractJson, interfaceCounters, junosJson, promptAtEnd,
  validateShowCommand,
} from "../lib/junos-shell.js";
import { openDeviceShell } from "../mist.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (f) => readFile(join(here, "fixtures", f), "utf8");

// ---- the gate ----------------------------------------------------------------

test("plain show commands pass, tidied", () => {
  for (const ok of [
    "show interfaces extensive ge-0/0/1",
    "show interfaces ge-0/0/*",
    "show interfaces diagnostics optics et-0/0/48",
    "show lldp neighbors",
    "show interfaces ae0.0 extensive",
    "show route 10.0.0.0/8",
    "show ethernet-switching table vlan-name v100",
  ]) assert.equal(validateShowCommand(ok), ok);
  assert.equal(validateShowCommand("  show   version  "), "show version");
});

test("anything that is not a plain show command is refused", () => {
  for (const bad of [
    "", "show", "request system reboot", "set interfaces ge-0/0/1 disable", "clear interfaces statistics all",
    "show version | save /var/tmp/x", "show version; request system reboot", "show version\nrequest system reboot",
    "show version && reboot", "show `id`", "show $(id)", "show version > /var/tmp/x", "Show version",
    "show inter\rfaces", "show inter\tfaces\x1b", "show configuration | display set", "show system processes | count",
    "start shell", "file delete /var/tmp/x", "show version\u0000", "show " + "x".repeat(200),
    "show interfaces request", "show set", "show interfaces clear",
  ]) assert.throws(() => validateShowCommand(bad), undefined, JSON.stringify(bad));
});

// ---- terminal output ---------------------------------------------------------

test("cleanTerminal strips NULs, escapes, CRs and backspaces", () => {
  assert.equal(cleanTerminal("a\x00b\r\n\x1b[1;32mc\x1b[0m\x1b]0;title\x07d\x1b(Bx_\x08y"), "ab\ncdxy");
});

test("promptAtEnd finds the Junos and Unix prompts, and nothing mid-output", () => {
  assert.deepEqual(promptAtEnd("x\n{master:0}\ndemo@demo-sw1> "), { who: "demo@demo-sw1", mode: ">" });
  assert.deepEqual(promptAtEnd("banner\nroot@demo-sw1:RE:0% "), { who: "root@demo-sw1:RE:0", mode: "%" });
  assert.equal(promptAtEnd('{\n  "name" : "x"\n'), null);
  assert.equal(promptAtEnd("demo@demo-sw1> show version\nJunos: 24.4"), null);
});

test("extractJson reads the reply out of the shell transcript, skipping {master:0}", async () => {
  const t = cleanTerminal(await fixture("junos-shell-transcript.txt"));
  const json = extractJson(t);
  assert.deepEqual(json, JSON.parse(await fixture("junos-show-interfaces-extensive.json")));
  assert.deepEqual(extractJson('{master:0}\n{ "a" : "}" }\n{master:0}'), { a: "}" });
});

test("extractJson reports Junos's own error when there is no JSON", () => {
  assert.throws(() => extractJson("show interfaces ge-9/9/9 | display json\nerror: device ge-9/9/9 not found\n\ndemo@sw> "),
    /device ge-9\/9\/9 not found/);
  assert.throws(() => extractJson('{ "a" : [ 1, 2'), /cut short/);
});

// ---- Junos JSON --------------------------------------------------------------

test("junosJson unwraps data values, flags, numbers and one-element containers", () => {
  const raw = {
    "x": [{ "a": [{ "data": "12" }], "b": [{ "data": "up" }], "flag": [{ "data": [null] }],
      "attributes": { "junos:style": "verbose" }, "q": [{ "n": [{ "data": "0" }] }, { "n": [{ "data": "1" }] }] }],
  };
  assert.deepEqual(junosJson(raw), { x: { a: 12, b: "up", flag: true, q: [{ n: 0 }, { n: 1 }] } });
  assert.deepEqual(asList({ a: 1 }), [{ a: 1 }]);
  assert.deepEqual(asList(undefined), []);
});

test("interfaceCounters gives the show interfaces extensive counters, flat", async () => {
  const [r] = interfaceCounters(JSON.parse(await fixture("junos-show-interfaces-extensive.json")));
  assert.equal(r.name, "ge-0/0/1");
  assert.equal(r.description, "uplink to demo-core");
  assert.equal(r.operStatus, "up");
  assert.equal(r.mtu, 1514);
  assert.equal(r.speed, "2500mbps");
  assert.equal(r.partnerSpeed, "1000 Mbps");
  const c = r.counters;
  assert.equal(c["in.input-errors"], 12);
  assert.equal(c["in.framing-errors"], 3);
  assert.equal(c["in.input-runts"], 0);
  assert.equal(c["in.input-fifo-errors"], 0);
  assert.equal(c["out.mtu-errors"], 5);
  assert.equal(c["out.carrier-transitions"], 1);
  assert.equal(c["mac.input-crc-errors"], 9);
  assert.equal(c["mac.output-fifo-errors"], 0);
  assert.equal(c["pcs.bit-error-seconds"], 0);
  assert.equal(typeof c["traffic.input-bytes"], "number");
  assert.equal(r.queues.length, 3);
  assert.equal(r.queues[1].drops, 7);
  assert.equal(c["queue.total-drop-packets"], 7);
  // Already-unwrapped JSON reads the same.
  const again = interfaceCounters(junosJson(JSON.parse(await fixture("junos-show-interfaces-extensive.json"))));
  assert.deepEqual(again[0], r);
});

// ---- the session -------------------------------------------------------------

/** A stand-in for the switch end of the Mist shell socket. */
class FakeSwitch {
  constructor({ prompt = "demo@demo-sw1> ", reply, start = "--- JUNOS 24.4\n{master:0}\n" } = {}) {
    this.readyState = 0;
    this.sent = [];
    this.prompt = prompt;
    this.reply = reply;
    this.start = start;
    this.closed = false;
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
      this.emit(`${this.start}${this.prompt}`);
    }, 1);
  }

  // The switch speaks in binary frames, sometimes split mid-character.
  emit(text, pieces = 3) {
    const bytes = new TextEncoder().encode(text);
    const step = Math.ceil(bytes.length / pieces);
    for (let i = 0; i < bytes.length; i += step) {
      const chunk = bytes.slice(i, i + step);
      setTimeout(() => this.onmessage?.({ data: chunk.buffer }), 1);
    }
  }

  send(data) {
    if (typeof data === "string") { this.sent.push(JSON.parse(data)); return; }
    const text = new TextDecoder().decode(data);
    assert.equal(text[0], "\x00", "keystrokes are prefixed with NUL");
    const line = text.slice(1);
    this.sent.push(line);
    const cmd = line.trim();
    if (cmd === "exit") { setTimeout(() => this.close(), 1); return; }
    if (cmd === "cli") { this.prompt = "root@demo-sw1> "; this.emit(`cli\r\n{master:0}\r\n${this.prompt}`); return; }
    if (cmd.startsWith("set cli")) { this.emit(`${cmd} \r\nScreen set\r\n\r\n{master:0}\r\n${this.prompt}`); return; }
    if (this.reply) this.emit(this.reply(cmd).replace(/demo@demo-sw1> $/, this.prompt), 5);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1005 });
  }
}

test("ShellSession resizes, unpages the CLI, and returns parsed JSON for show commands", async () => {
  const transcript = await fixture("junos-shell-transcript.txt");
  const sw = new FakeSwitch({ reply: (cmd) => (cmd.includes("ge-0/0/1") ? transcript : "") });
  const s = await new ShellSession(sw).start();
  assert.deepEqual(sw.sent[0], { resize: { width: 1000, height: 50 } });
  assert.deepEqual(sw.sent.slice(1, 3), ["set cli screen-length 0\n", "set cli screen-width 0\n"]);
  const [a, b] = await Promise.all([
    s.show("show interfaces extensive ge-0/0/1"),
    s.show("show interfaces extensive ge-0/0/1"),
  ]);
  assert.equal(sw.sent[3], "show interfaces extensive ge-0/0/1 | display json | no-more\n");
  assert.equal(interfaceCounters(a)[0].counters["out.mtu-errors"], 5);
  assert.deepEqual(a, b);
  s.close();
  assert.equal(sw.sent.at(-1), "exit\n");
  await assert.rejects(s.show("show version"), /closed/);
});

test("ShellSession refuses non-show commands before sending anything", async () => {
  const sw = new FakeSwitch({ reply: () => "" });
  const s = await new ShellSession(sw).start();
  const before = sw.sent.length;
  assert.throws(() => s.show("request system reboot"), /show/);
  assert.equal(sw.sent.length, before);
  s.close();
});

test("ShellSession steps from a Unix prompt into the Junos CLI", async () => {
  const sw = new FakeSwitch({ prompt: "root@demo-sw1:RE:0% ", reply: () => "" });
  const s = await new ShellSession(sw).start();
  assert.ok(sw.sent.includes("cli\n"));
  assert.equal(s.prompt.mode, ">");
  s.close();
});

test("ShellSession times out a command that never finishes, and fails pending calls when the switch hangs up", async () => {
  const sw = new FakeSwitch({ reply: () => '{ "partial" : ' });
  const s = await new ShellSession(sw, { commandTimeoutMs: 50 }).start();
  await assert.rejects(s.show("show version"), /did not answer/);
  assert.ok(s.closed);

  const sw2 = new FakeSwitch({ reply: () => "" });
  const s2 = await new ShellSession(sw2).start();
  const pending = s2.show("show version");
  setTimeout(() => sw2.close(), 5);
  await assert.rejects(pending, /closed the CLI session/);
});

test("ShellSession fails cleanly when the socket never opens", async () => {
  const dead = { readyState: 0, send() {}, close() {} };
  const s = new ShellSession(dead, { startTimeoutMs: 30 });
  await assert.rejects(s.start(), /did not open/);
  const refused = { readyState: 0, send() {}, close() {} };
  const s2 = new ShellSession(refused);
  const started = s2.start();
  refused.onclose();
  await assert.rejects(started, /closed the CLI session/);
});

// ---- the transport -----------------------------------------------------------

const SITE = "11111111-2222-3333-4444-555555555555";
const DEV = "00000000-0000-0000-1000-020000000001";

function stubShellPost(reply, status = 200) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body, auth: init.headers.Authorization });
    return {
      ok: status < 300, status, headers: { get: () => null },
      text: async () => JSON.stringify(reply),
    };
  };
  const sockets = [];
  globalThis.WebSocket = class { constructor(u) { this.url = u; sockets.push(this); } };
  return { calls, sockets };
}

test("openDeviceShell POSTs once, then connects to the region's api-ws host only", async () => {
  const { calls, sockets } = stubShellPost({ session: "s", url: "wss://api-ws.gc2.mist.com/ssh?jwt=abc" });
  const ws = await openDeviceShell("api.gc2.mist.com", "tok", SITE, DEV);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, `https://api.gc2.mist.com/api/v1/sites/${SITE}/devices/${DEV}/shell`);
  assert.equal(calls[0].body, "{}");
  assert.equal(ws, sockets[0]);
  assert.equal(ws.url, "wss://api-ws.gc2.mist.com/ssh?jwt=abc");
  assert.equal(ws.binaryType, "arraybuffer");
});

test("openDeviceShell refuses addresses outside the selected region, without echoing them", async () => {
  for (const url of [
    "wss://evil.example.com/ssh?jwt=abc",
    "wss://api-ws.mist.com/ssh?jwt=abc",            // another region
    "ws://api-ws.gc2.mist.com/ssh?jwt=abc",         // not TLS
    "wss://api-ws.gc2.mist.com/other?jwt=abc",
    "not a url",
  ]) {
    const { sockets } = stubShellPost({ url });
    await assert.rejects(openDeviceShell("api.gc2.mist.com", "tok", SITE, DEV), (e) => {
      assert.ok(!e.message.includes("jwt") && !e.message.includes("evil"), e.message);
      return true;
    });
    assert.equal(sockets.length, 0, url);
  }
});

test("openDeviceShell checks the ids and explains a 403", async () => {
  stubShellPost({});
  await assert.rejects(openDeviceShell("api.gc2.mist.com", "tok", "../orgs", DEV), /site id and device id/);
  await assert.rejects(openDeviceShell("api.gc2.mist.com", "tok", SITE, `${DEV}/../../x`), /site id and device id/);
  stubShellPost({ detail: "forbidden" }, 403);
  await assert.rejects(openDeviceShell("api.gc2.mist.com", "tok", SITE, DEV), /admin-level role/);
});
