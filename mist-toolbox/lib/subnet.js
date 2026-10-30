// IPv4/IPv6 address and network math, replacing Python's ipaddress module.
//
// Addresses are held as BigInt because mist_ip_blocks.py's overlap sweep
// compares int(network_address), and an IPv6 /64 does not fit in a JS Number.

const V4_MAX = (1n << 32n) - 1n;
const V6_MAX = (1n << 128n) - 1n;

export class AddrError extends Error {}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseV4(text) {
  const parts = String(text).split(".");
  if (parts.length !== 4) throw new AddrError(`not an IPv4 address: ${text}`);
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) throw new AddrError(`not an IPv4 address: ${text}`);
    const v = Number(p);
    if (v > 255) throw new AddrError(`octet out of range: ${text}`);
    n = (n << 8n) | BigInt(v);
  }
  return n;
}

function parseV6(text) {
  let s = String(text);
  if (s.includes("%")) s = s.slice(0, s.indexOf("%"));   // drop a zone id
  if (s.split("::").length > 2) throw new AddrError(`not an IPv6 address: ${text}`);

  const [headRaw, tailRaw] = s.includes("::") ? s.split("::") : [s, null];
  const splitGroups = (part) => (part === "" ? [] : part.split(":"));
  let head = splitGroups(headRaw);
  let tail = tailRaw === null ? [] : splitGroups(tailRaw);

  // A trailing embedded IPv4 (::ffff:192.0.2.1) counts as two groups.
  const expandEmbedded = (groups) => {
    if (!groups.length) return groups;
    const last = groups[groups.length - 1];
    if (!last.includes(".")) return groups;
    const v4 = parseV4(last);
    return [
      ...groups.slice(0, -1),
      ((v4 >> 16n) & 0xffffn).toString(16),
      (v4 & 0xffffn).toString(16),
    ];
  };
  head = expandEmbedded(head);
  tail = expandEmbedded(tail);

  const fill = 8 - (head.length + tail.length);
  if (tailRaw === null) {
    if (head.length !== 8) throw new AddrError(`not an IPv6 address: ${text}`);
  } else if (fill < 1) {
    throw new AddrError(`not an IPv6 address: ${text}`);
  }
  const groups = tailRaw === null ? head : [...head, ...Array(fill).fill("0"), ...tail];

  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) throw new AddrError(`not an IPv6 address: ${text}`);
    n = (n << 16n) | BigInt(Number.parseInt(g, 16));
  }
  return n;
}

export function parseAddr(text) {
  const s = String(text).trim();
  if (s.includes(":")) return { version: 6, value: parseV6(s) };
  return { version: 4, value: parseV4(s) };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatV4(n) {
  return [24n, 16n, 8n, 0n].map((sh) => Number((n >> sh) & 0xffn)).join(".");
}

/** RFC 5952 form, matching what Python's str(IPv6Address) produces. */
export function formatV6(n) {
  const groups = [];
  for (let i = 7n; i >= 0n; i -= 1n) groups.push(Number((n >> (i * 16n)) & 0xffffn));

  // Longest run of zero groups, leftmost on a tie, only if 2 or more.
  let best = { start: -1, len: 0 };
  let cur = { start: -1, len: 0 };
  groups.forEach((g, i) => {
    if (g === 0) {
      if (cur.start < 0) cur = { start: i, len: 1 };
      else cur.len += 1;
      if (cur.len > best.len) best = { ...cur };
    } else {
      cur = { start: -1, len: 0 };
    }
  });

  const hex = groups.map((g) => g.toString(16));
  if (best.len < 2) return hex.join(":");
  const head = hex.slice(0, best.start).join(":");
  const tail = hex.slice(best.start + best.len).join(":");
  return `${head}::${tail}`;
}

export const formatAddr = (version, n) => (version === 4 ? formatV4(n) : formatV6(n));

// ---------------------------------------------------------------------------
// Networks
// ---------------------------------------------------------------------------

/**
 * Python's ip_interface: an address plus the network it sits in.
 * Accepts "10.1.1.1/24", "10.1.1.1" (host route) and IPv6 equivalents.
 * @throws {AddrError}
 */
export function ipInterface(cidr) {
  const text = String(cidr).trim();
  const slash = text.lastIndexOf("/");
  const addrText = slash < 0 ? text : text.slice(0, slash);
  const { version, value: ip } = parseAddr(addrText);
  const width = version === 4 ? 32 : 128;

  let prefixlen = width;
  if (slash >= 0) {
    const raw = text.slice(slash + 1);
    if (!/^\d{1,3}$/.test(raw)) throw new AddrError(`bad prefix length: ${cidr}`);
    prefixlen = Number(raw);
    if (prefixlen > width) throw new AddrError(`bad prefix length: ${cidr}`);
  }

  const max = version === 4 ? V4_MAX : V6_MAX;
  const hostBits = BigInt(width - prefixlen);
  const netmask = prefixlen === 0 ? 0n : ((max >> hostBits) << hostBits) & max;
  const hostmask = max ^ netmask;
  const networkAddress = ip & netmask;
  const broadcastAddress = networkAddress | hostmask;

  return {
    version,
    ip,
    prefixlen,
    netmask,
    hostmask,
    networkAddress,
    broadcastAddress,
    numAddresses: 1n << hostBits,
    ipStr: formatAddr(version, ip),
    networkStr: `${formatAddr(version, networkAddress)}/${prefixlen}`,
  };
}

/** True for 169.254/16 and fe80::/10, as ipaddress's is_link_local is. */
export function isLinkLocal(version, value) {
  if (version === 4) return (value >> 16n) === 0xa9fen;
  return (value >> 118n) === 0x3fan;   // fe80::/10
}

/** Do two networks overlap at all? Used for the cross-site duplicate sweep. */
export function overlaps(a, b) {
  if (a.version !== b.version) return false;
  return a.networkAddress <= b.broadcastAddress && b.networkAddress <= a.broadcastAddress;
}

/**
 * network_details() from mist_ip_blocks.py: the per-address facts the IRB
 * sheet reports, including the /31 and /32 special cases.
 */
export function networkDetails(cidr) {
  let iface;
  try {
    iface = ipInterface(cidr);
  } catch {
    return { Notes: `Unparseable address '${cidr}'`, _notes: [`Unparseable address '${cidr}'`] };
  }

  const f = (n) => formatAddr(iface.version, n);
  const notes = [];
  const d = {
    "IP Address": iface.ipStr,
    "Prefix Length": iface.prefixlen,
    Network: iface.networkStr,
    "Network Address": f(iface.networkAddress),
    _network: iface,
  };

  if (iface.version === 4) {
    d["Subnet Mask"] = f(iface.netmask);
    d["Wildcard Mask"] = f(iface.hostmask);
    if (iface.prefixlen <= 30) {
      d.Broadcast = f(iface.broadcastAddress);
      d["First Usable"] = f(iface.networkAddress + 1n);
      d["Last Usable"] = f(iface.broadcastAddress - 1n);
      d["Usable Hosts"] = Number(iface.numAddresses - 2n);
      if (iface.ip === iface.networkAddress) notes.push("IP is the network address");
      else if (iface.ip === iface.broadcastAddress) notes.push("IP is the broadcast address");
    } else if (iface.prefixlen === 31) {
      d.Broadcast = "n/a (/31)";
      d["First Usable"] = f(iface.networkAddress);
      d["Last Usable"] = f(iface.networkAddress + 1n);
      d["Usable Hosts"] = 2;
    } else {
      d.Broadcast = "n/a (/32)";
      d["First Usable"] = iface.ipStr;
      d["Last Usable"] = iface.ipStr;
      d["Usable Hosts"] = 1;
    }
  } else {
    const hostBits = 128 - iface.prefixlen;
    d.Broadcast = "n/a (IPv6)";
    d["First Usable"] = f(iface.networkAddress);
    d["Last Usable"] = f(iface.broadcastAddress);
    d["Usable Hosts"] = hostBits <= 32 ? Number(iface.numAddresses) : `2^${hostBits}`;
    if (isLinkLocal(iface.version, iface.ip)) notes.push("Link-local");
  }

  d._notes = notes;
  return d;
}
