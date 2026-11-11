// Read-only Junos CLI over the Mist remote shell.
//
// Mist opens a CLI session on a switch through POST .../devices/{id}/shell,
// which answers with a wss:// URL that carries its own short-lived JWT. The
// socket itself is opened by mist.js (the only network code); this file holds
// everything after that, and nothing here touches the network or the token:
//
//   * validateShowCommand: the gate. Only plain `show …` commands pass, with no
//     pipes, separators or control characters, so a tool can read but never
//     configure, clear, restart or write files.
//   * ShellSession: speaks the shell protocol on a socket it is handed. Text
//     frame {"resize":…} first; keystrokes as binary frames of "\x00" + text;
//     the device answers with raw terminal bytes. Commands run one at a time,
//     each up to the next CLI prompt.
//   * cleanTerminal / extractJson / junosJson / interfaceCounters: turn the
//     terminal output of `show … | display json | no-more` into plain records.
//
// Verified against EX4400 and QFX5120 on Junos 24.4: the session starts at the
// Junos CLI prompt ("{master:0}\nuser@host> "), and NUL bytes appear all
// through the output, including inside the JSON, so they are stripped first.

export const SHELL_COLS = 1000;
export const SHELL_ROWS = 50;
export const COMMAND_TIMEOUT_MS = 30000;
export const START_TIMEOUT_MS = 20000;
const MAX_COMMAND = 200;
const MAX_OUTPUT = 8 * 1024 * 1024;

const SHOW = /^show(?: [A-Za-z0-9_.\/:*,\-]+)+$/;
// Words that never belong in a read-only command, even as an argument.
const BANNED_WORDS = /(^| )(request|set|clear|start|restart|file|configure|commit|delete|load|save|test|monitor)( |$)/i;

/**
 * Return the command, tidied, if it is a plain read-only `show` command;
 * throw otherwise. The shell adds `| display json | no-more` itself.
 */
export function validateShowCommand(command) {
  const cmd = String(command ?? "").trim().replace(/[ \t]+/g, " ");
  if (!cmd) throw new Error("No command given.");
  if (cmd.length > MAX_COMMAND) throw new Error(`Command longer than ${MAX_COMMAND} characters.`);
  if (!SHOW.test(cmd)) {
    throw new Error(`Only plain "show …" commands are allowed (letters, digits, spaces and _ . / : * , -; no pipes): ${cmd}`);
  }
  if (BANNED_WORDS.test(cmd.slice(5))) throw new Error(`Not a read-only show command: ${cmd}`);
  return cmd;
}

/** Strip NULs, ANSI/VT escapes, carriage returns and backspaces from terminal output. */
export function cleanTerminal(text) {
  return String(text ?? "")
    .replace(/\x00/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")      // OSC (window title)
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "")             // CSI
    .replace(/\x1b[()][A-Za-z0-9]|\x1b[=>78DEHMc]/g, "")    // charset, keypad, misc
    .replace(/[^\n\x08]\x08/g, "")
    .replace(/\r/g, "");
}

// "user@host> " (Junos operational mode) or "user@host:RE:0% " (Unix shell).
const PROMPT = /(?:^|\n)([\w.-]+@[\w.:-]+)([>#%]) ?$/;

/** The CLI prompt at the end of `text`, if the output ends with one. */
export function promptAtEnd(text) {
  const m = PROMPT.exec(text.replace(/[ \t]+$/, " "));
  return m ? { who: m[1], mode: m[2] } : null;
}

/**
 * The first JSON object in a command's output, parsed. Junos prints the echoed
 * command, then the JSON, then the "{master:0}" line and the prompt; the
 * search starts at the first "{" that opens a JSON key, so "{master:0}" is
 * never mistaken for it. Throws with Junos's own message when there is none.
 */
export function extractJson(text) {
  const s = String(text ?? "");
  const m = /\{\s*"/.exec(s);
  if (!m) {
    const msg = s.split("\n").map((l) => l.trim()).find((l) => /^error\b|syntax error|unknown command/i.test(l));
    throw new Error(`The switch returned no data${msg ? `: ${msg}` : "."}`);
  }
  let depth = 0;
  let inStr = false;
  for (let i = m.index; i < s.length; i += 1) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i += 1;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(s.slice(m.index, i + 1));
    }
  }
  throw new Error("The switch's reply was cut short.");
}

/**
 * Unwrap Junos JSON. Junos wraps every value as [{"data": "…"}] and every
 * container as a one-element array. This turns values into strings or numbers
 * (integer strings become numbers), flags ([{"data":[null]}]) into true,
 * one-element containers into objects, and drops "attributes".
 * Repeated elements (queues, logical interfaces) stay arrays.
 */
export function junosJson(v) {
  if (Array.isArray(v)) {
    if (v.length === 1 && v[0] && typeof v[0] === "object" && !Array.isArray(v[0]) && "data" in v[0]
      && Object.keys(v[0]).every((k) => k === "data" || k === "attributes")) {
      return scalar(v[0].data);
    }
    const items = v.map(junosJson);
    return items.length === 1 && items[0] && typeof items[0] === "object" ? items[0] : items;
  }
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "attributes") continue;
      out[k] = junosJson(val);
    }
    return out;
  }
  return scalar(v);
}

function scalar(d) {
  if (Array.isArray(d)) return d.length === 1 && d[0] === null ? true : d;
  if (typeof d === "string" && /^-?\d{1,18}$/.test(d.trim())) return Number(d.trim());
  return d;
}

/** Always an array: a container Junos sent once comes back as an object. */
export const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

// Counter groups of `show interfaces extensive`, and the short prefix each one
// gets in a flat counters record ("in.input-errors", "mac.input-crc-errors").
const GROUPS = [
  ["traffic-statistics", "traffic"],
  ["input-error-list", "in"],
  ["output-error-list", "out"],
  ["ethernet-mac-statistics", "mac"],
  ["ethernet-pcs-statistics", "pcs"],
];

/**
 * One flat record per physical interface in a `show interfaces extensive`
 * reply (raw Junos JSON or already unwrapped):
 *   { name, description, adminStatus, operStatus, mtu, speed, linkMode,
 *     flapped, cleared, partnerSpeed, autoneg, counters, queues }
 * `counters` maps "<group>.<junos-name>" to a number; `queues` lists the egress
 * queues with their queued, transmitted and dropped packets.
 */
export function interfaceCounters(json) {
  const j = json && json["interface-information"] && Array.isArray(json["interface-information"])
    ? junosJson(json) : json;
  const info = j?.["interface-information"];
  return asList(info?.["physical-interface"]).map((pi) => {
    const counters = {};
    for (const [group, prefix] of GROUPS) {
      const g = pi[group];
      if (!g || typeof g !== "object") continue;
      for (const [k, v] of Object.entries(g)) {
        if (typeof v === "number") counters[`${prefix}.${k}`] = v;
      }
    }
    const queues = asList(pi["queue-counters"]?.queue).map((q) => ({
      number: q["queue-number"],
      name: q["forwarding-class-name"] || "",
      queued: num(q["queue-counters-queued-packets"]),
      transmitted: num(q["queue-counters-trans-packets"]),
      drops: num(q["queue-counters-total-drop-packets"]),
    }));
    if (queues.length) counters["queue.total-drop-packets"] = queues.reduce((n, q) => n + (q.drops || 0), 0);
    const an = pi["ethernet-autonegotiation"] || {};
    return {
      name: String(pi.name ?? ""),
      description: pi.description ?? "",
      adminStatus: pi["admin-status"] ?? "",
      operStatus: pi["oper-status"] ?? "",
      mtu: num(pi.mtu),
      speed: pi.speed ?? "",
      linkMode: pi["link-mode"] ?? "",
      flapped: pi["interface-flapped"] ?? "",
      cleared: pi["statistics-cleared"] ?? "",
      autoneg: an["autonegotiation-status"] ?? "",
      partnerSpeed: an["link-partner-speed"] ?? "",
      counters,
      queues,
    };
  });
}

function num(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/**
 * One CLI session on one device, over a socket mist.js opened. The socket
 * needs the browser WebSocket surface: send, close, readyState and the
 * onopen/onmessage/onclose/onerror handlers.
 */
export class ShellSession {
  constructor(socket, { commandTimeoutMs = COMMAND_TIMEOUT_MS, startTimeoutMs = START_TIMEOUT_MS } = {}) {
    this.socket = socket;
    this.commandTimeoutMs = commandTimeoutMs;
    this.startTimeoutMs = startTimeoutMs;
    this.closed = false;
    this.closeReason = "";
    this.buf = "";
    this.waiter = null;          // { test(), resolve, reject, timer }
    this.queue = Promise.resolve();
    this.decoder = new TextDecoder();
    this.encoder = new TextEncoder();

    socket.binaryType = "arraybuffer";
    socket.onmessage = (ev) => this.onData(ev.data);
    socket.onclose = () => this.fail("The switch closed the CLI session.");
    socket.onerror = () => this.fail("The CLI session failed (network error).");
  }

  onData(data) {
    const text = typeof data === "string" ? data : this.decoder.decode(data, { stream: true });
    this.buf += text;
    if (this.buf.length > MAX_OUTPUT) {
      this.fail("The switch sent more output than expected.");
      return;
    }
    this.check();
  }

  check() {
    const w = this.waiter;
    if (w && w.test(cleanTerminal(this.buf))) {
      this.waiter = null;
      clearTimeout(w.timer);
      w.resolve(cleanTerminal(this.buf));
    }
  }

  /** Wait until the output so far satisfies `test`, or time out. */
  waitFor(test, ms, what) {
    if (this.closed) return Promise.reject(new Error(this.closeReason));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`The switch did not answer within ${Math.round(ms / 1000)} s (${what}).`));
        this.close();
      }, ms);
      this.waiter = { test, resolve, reject, timer };
      this.check();
    });
  }

  sendKeys(text) {
    if (this.closed) throw new Error(this.closeReason);
    this.socket.send(this.encoder.encode(`\x00${text}`));
  }

  /** Open the session: resize, wait for the prompt, then make output unpaged. */
  async start() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The CLI session did not open.")), this.startTimeoutMs);
      this.opening = { reject: (e) => { clearTimeout(timer); reject(e); } };
      const ready = () => {
        clearTimeout(timer);
        this.opening = null;
        try {
          this.socket.send(JSON.stringify({ resize: { width: SHELL_COLS, height: SHELL_ROWS } }));
          resolve();
        } catch (e) {
          reject(e);
        }
      };
      if (this.socket.readyState === 1) ready();
      else this.socket.onopen = ready;
    });
    let prompt = promptAtEnd(await this.waitFor((t) => !!promptAtEnd(t), this.startTimeoutMs, "waiting for the prompt"));
    if (prompt.mode === "%") {
      // A Unix shell (root login): step into the Junos CLI.
      this.buf = "";
      this.sendKeys("cli\n");
      prompt = promptAtEnd(await this.waitFor((t) => promptAtEnd(t)?.mode === ">", this.startTimeoutMs, "starting the CLI"));
    }
    this.prompt = prompt;
    await this.exec("set cli screen-length 0");
    await this.exec("set cli screen-width 0");
    return this;
  }

  /** Run one line (internal; callers go through show()). Returns the cleaned output. */
  async exec(line) {
    this.buf = "";
    this.decoder = new TextDecoder();
    this.sendKeys(`${line}\n`);
    // The prompt counts only after the echoed command, so a prompt left over
    // from before cannot end the wait early.
    const out = await this.waitFor((t) => t.includes("\n") && !!promptAtEnd(t), this.commandTimeoutMs, line.split(" |")[0]);
    return out;
  }

  /** Run a read-only show command and return its JSON, parsed. Calls are serialised. */
  show(command) {
    const cmd = validateShowCommand(command);
    const run = this.queue.then(() => this.exec(`${cmd} | display json | no-more`)).then(extractJson);
    this.queue = run.catch(() => {});
    return run;
  }

  fail(message) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = message;
    if (this.opening) this.opening.reject(new Error(message));
    const w = this.waiter;
    if (w) {
      this.waiter = null;
      clearTimeout(w.timer);
      w.reject(new Error(message));
    }
  }

  close() {
    if (!this.closed) {
      try {
        if (this.socket.readyState === 1) this.sendKeys("exit\n");
      } catch { /* closing anyway */ }
    }
    this.fail("The CLI session was closed.");
    try { this.socket.close(); } catch { /* already closed */ }
  }
}
