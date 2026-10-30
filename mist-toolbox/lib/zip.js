// Minimal ZIP writer, which is all an .xlsx needs — the format is a zip of XML.
//
// There is no dependency here on purpose. The browser has had
// CompressionStream("deflate-raw") since Chrome 80 and this extension requires
// 116, so real DEFLATE comes from the platform. That keeps the toolbox at zero
// third-party code, which in turn lets tests/policy.test.js keep its absolute
// ban on console.* across every shipped file.
//
// Scope: no ZIP64, no encryption, no directory entries. Entries must stay under
// 4 GB each, which a spreadsheet will not reach.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** DOS date/time, the only timestamp format a classic zip header carries. */
function dosDateTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

class Writer {
  constructor(size) {
    this.b = new Uint8Array(size);
    this.i = 0;
  }
  u16(v) { this.b[this.i++] = v & 0xff; this.b[this.i++] = (v >>> 8) & 0xff; return this; }
  u32(v) { this.u16(v & 0xffff); this.u16((v >>> 16) & 0xffff); return this; }
  bytes(a) { this.b.set(a, this.i); this.i += a.length; return this; }
}

/**
 * Build a zip Blob.
 *
 * @param {Array<{name: string, data: Uint8Array|string|Array<string>}>} entries
 *   `data` may be a string, a Uint8Array, or an array of string chunks — the
 *   array form matters for the big sheets, where one 60 MB concatenation is
 *   worth avoiding.
 * @param {string} mime
 */
export async function zip(entries, mime = "application/zip") {
  const enc = new TextEncoder();
  const now = new Date();
  const { time, date } = dosDateTime(now);

  const parts = [];      // Blob parts, in file order
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = typeof entry.data === "string" ? enc.encode(entry.data)
      : Array.isArray(entry.data) ? enc.encode(entry.data.join(""))
        : entry.data;
    const name = enc.encode(entry.name);
    const sum = crc32(raw);
    const body = await deflateRaw(raw);

    const local = new Writer(30 + name.length);
    local.u32(0x04034b50).u16(20).u16(0).u16(8).u16(time).u16(date)
      .u32(sum).u32(body.length).u32(raw.length).u16(name.length).u16(0).bytes(name);
    parts.push(local.b, body);

    const cd = new Writer(46 + name.length);
    cd.u32(0x02014b50).u16(20).u16(20).u16(0).u16(8).u16(time).u16(date)
      .u32(sum).u32(body.length).u32(raw.length)
      .u16(name.length).u16(0).u16(0).u16(0).u16(0).u32(0).u32(offset).bytes(name);
    central.push(cd.b);

    offset += local.b.length + body.length;
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Writer(22);
  end.u32(0x06054b50).u16(0).u16(0).u16(entries.length).u16(entries.length)
    .u32(cdSize).u32(offset).u16(0);

  return new Blob([...parts, ...central, end.b], { type: mime });
}
