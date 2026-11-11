// A stand-in Junos switch CLI for the screenshots: a local TLS WebSocket server
// that speaks the Mist remote-shell protocol the way real EX and QFX switches
// do (checked against both on Junos 24.4):
//
//   * the browser sends a text frame {"resize":{…}}, then keystrokes as binary
//     frames of "\x00" + text;
//   * the switch answers in binary frames, with NUL bytes scattered through its
//     output, and ends every reply with "{master:0}" and the "user@host> " prompt.
//
// Chromium is pointed at it with --host-resolver-rules (every Mist api-ws host
// maps to 127.0.0.1) and --ignore-certificate-errors, so the extension runs
// unchanged. The certificate is made on the fly with the openssl CLI; nothing is
// installed. Answers come from tests/fixtures/junos-show-interfaces-extensive.json
// (synthetic), with each switch's MTU and counters that grow on every read.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import https from "node:https";
import { join } from "node:path";

/**
 * Start the fake switch on 127.0.0.1:`port`.
 * `switches` maps the jwt the /shell fixture hands out to
 * { name, mtu, grow: { "<group>/<counter>": perRead } }.
 * Returns { close(), log } where log lists what the switches were sent.
 */
export async function startFakeSwitch({ port, workDir, fixturePath, switches }) {
  const key = join(workDir, "fakeswitch-key.pem");
  const cert = join(workDir, "fakeswitch-cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=api-ws.mist.com",
    "-keyout", key, "-out", cert], { stdio: "ignore" });
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const log = [];
  const server = https.createServer({ key: await readFile(key), cert: await readFile(cert) });
  const sockets = new Set();

  server.on("upgrade", (req, sock) => {
    const url = new URL(req.url, "https://localhost");
    const sw = switches[url.searchParams.get("jwt")];
    if (!sw || url.pathname !== "/ssh") { sock.end("HTTP/1.1 401 Unauthorized\r\n\r\n"); return; }
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);

    const prompt = `demo@${sw.name}> `;
    let reads = 0;
    const send = (text) => {
      const body = Buffer.from(text, "utf8");
      for (let i = 0; i < body.length; i += 4096) {
        const p = body.subarray(i, i + 4096);
        const head = p.length < 126 ? Buffer.from([0x82, p.length]) : Buffer.from([0x82, 126, p.length >> 8, p.length & 255]);
        sock.write(Buffer.concat([head, p]));
      }
    };
    const sprinkle = (s) => [...s].map((ch, k) => (k % 97 === 0 ? `${ch}\x00` : ch)).join("").replace(/\n/g, "\r\n");

    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 15;
        let len = buf[1] & 127;
        let off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const data = Buffer.from(buf.subarray(off + 4, off + 4 + len)).map((b, i) => b ^ mask[i % 4]);
        buf = buf.subarray(off + 4 + len);
        if (op === 8) { sock.end(); return; }
        const text = Buffer.from(data).toString("utf8");
        if (op === 1) {                                   // the resize frame
          send(`--- JUNOS 24.4R2 Kernel 64-bit\r\n\x00{master:0}\r\n${prompt}`);
          continue;
        }
        const line = text.replace(/^\x00/, "").trim();
        log.push(`${sw.name}: ${line}`);
        if (line === "exit") { sock.end(); return; }
        if (line.startsWith("set cli")) { send(`${line} \r\nScreen set\r\n\r\n{master:0}\r\n${prompt}`); continue; }
        const m = line.match(/^show interfaces extensive (\S+) \| display json \| no-more$/);
        if (!m) { send(`${line}\r\nerror: syntax error\r\n\r\n{master:0}\r\n${prompt}`); continue; }
        reads += 1;
        const j = JSON.parse(JSON.stringify(fixture));
        const pi = j["interface-information"][0]["physical-interface"][0];
        pi.name = [{ data: m[1] }];
        pi.mtu = [{ data: String(sw.mtu) }];
        pi.description = [{ data: sw.description || "" }];
        for (const [path, step] of Object.entries(sw.grow || {})) {
          const [group, counter] = path.split("/");
          const g = pi[group][0];
          g[counter] = [{ data: String(Number(g[counter][0].data) + reads * step) }];
        }
        setTimeout(() => send(`show interfaces extensive\x00 ${m[1]}\x00 | display json | no-more \r\n\x00${sprinkle(JSON.stringify(j, null, 4))}\r\n\r\n{master:0}\r\n${prompt}`), 120);
      }
    });
  });

  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return {
    log,
    close: () => { for (const s of sockets) s.destroy(); server.close(); },
  };
}
