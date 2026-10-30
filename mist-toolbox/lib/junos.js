// Junos `set` command parsing for the IRB report.
//
// Two pieces of Python have no JS equivalent and are reimplemented here:
// shlex.split (POSIX mode, which is what mist_ip_blocks.py's _tokenize used)
// and the IRB/VLAN/routing-instance walk over the config Mist generates.

export const IGNORED_VERBS = new Set([
  "delete", "deactivate", "activate", "insert", "rename",
  "annotate", "protect", "unprotect",
]);
export const DHCP_KEYWORDS = new Set(["dhcp", "dhcp-client", "dhcpv6-client", "autoconfig"]);
export const VIRTUAL_ADDR_KEYWORDS = new Set([
  "virtual-gateway-address", "virtual-address",
  "virtual-inet6-address", "virtual-link-local-address",
]);
export const FAMILY_LABEL = { inet: "IPv4", inet6: "IPv6" };

export class QuoteError extends Error {}

/**
 * shlex.split(line) in POSIX mode: whitespace splits, single quotes are
 * literal, double quotes allow backslash escapes of " and \, and an
 * unterminated quote is an error.
 * @throws {QuoteError} on an unclosed quote, which _tokenize caught.
 */
export function shlexSplit(line) {
  const out = [];
  let cur = "";
  let has = false;
  let i = 0;
  const s = String(line);

  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      if (has) { out.push(cur); cur = ""; has = false; }
      i += 1;
    } else if (c === "'") {
      has = true;
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new QuoteError("No closing quotation");
      cur += s.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      has = true;
      i += 1;
      let closed = false;
      while (i < s.length) {
        if (s[i] === "\\" && i + 1 < s.length && (s[i + 1] === '"' || s[i + 1] === "\\")) {
          cur += s[i + 1]; i += 2;
        } else if (s[i] === '"') {
          closed = true; i += 1; break;
        } else {
          cur += s[i]; i += 1;
        }
      }
      if (!closed) throw new QuoteError("No closing quotation");
    } else if (c === "\\") {
      has = true;
      if (i + 1 < s.length) { cur += s[i + 1]; i += 2; } else { i += 1; }
    } else {
      has = true; cur += c; i += 1;
    }
  }
  if (has) out.push(cur);
  return out;
}

/** _tokenize: shlex, falling back to a plain split on an unbalanced quote. */
export function tokenize(line) {
  try {
    return shlexSplit(line);
  } catch {
    return String(line).split(/\s+/).filter(Boolean);
  }
}

/** Key for the per-unit address map; inet/inet6 never contain a pipe. */
const addrKey = (family, address) => `${family}|${address}`;

function handleIrbUnit(unit, rest) {
  if (!rest.length) return;
  const key = rest[0];
  if (key === "description") {
    unit.description = rest.slice(1).join(" ");
  } else if (key === "disable") {
    unit.disabled = true;
  } else if (key === "family" && rest.length >= 3) {
    const family = rest[1];
    const frest = rest.slice(2);
    if (frest[0] === "address" && frest.length >= 2) {
      const k = addrKey(family, frest[1]);
      let addr = unit.addresses.get(k);
      if (!addr) {
        addr = { family, address: frest[1], flags: [], virtual: [] };
        unit.addresses.set(k, addr);
      }
      const attrs = frest.slice(2);
      attrs.forEach((tok, i) => {
        const nxt = i + 1 < attrs.length ? attrs[i + 1] : null;
        if ((tok === "primary" || tok === "preferred") && !addr.flags.includes(tok)) {
          addr.flags.push(tok);
        } else if (VIRTUAL_ADDR_KEYWORDS.has(tok) && nxt && !addr.virtual.includes(nxt)) {
          addr.virtual.push(nxt);
        } else if ((tok === "vrrp-group" || tok === "vrrp-inet6-group") && nxt) {
          const flag = `vrrp-group ${nxt}`;
          if (!addr.flags.includes(flag)) addr.flags.push(flag);
        }
      });
    } else if (DHCP_KEYWORDS.has(frest[0])) {
      if (!unit.dhcp.some(([f, k2]) => f === family && k2 === frest[0])) {
        unit.dhcp.push([family, frest[0]]);
      }
    }
  }
}

/**
 * Parse Junos `set` commands into IRB units plus the VLAN and routing-instance
 * mappings that reference them. Handles statements wrapped in `groups <name>`,
 * which is where Mist puts its config ("groups top").
 *
 * @param {string|string[]} config
 * @returns {{units: Map<string, object>, vlans: Map<string, object>,
 *            routingInstances: Record<string, string>}}
 */
export function parseIrbConfig(config) {
  const lines = Array.isArray(config) ? config : String(config).split(/\r?\n/);
  const units = new Map();
  const vlans = new Map();
  const routingInstances = {};

  const handleVlan = (name, rest) => {
    if (rest.length < 2) return;
    const v = vlans.get(name) || {};
    if (rest[0] === "vlan-id") v.vlan_id = rest[1];
    else if (rest[0] === "l3-interface") v.l3_interface = rest[1];
    vlans.set(name, v);
  };

  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line || line.startsWith("#")) continue;
    let tok = tokenize(line);
    if (!tok.length || IGNORED_VERBS.has(tok[0])) continue;
    if (tok[0] === "set") tok = tok.slice(1);
    if (tok.length >= 2 && tok[0] === "groups") tok = tok.slice(2);
    if (tok.length < 3) continue;

    if (tok[0] === "interfaces") {
      let unitNo;
      let rest;
      if (tok[1] === "irb" && tok[2] === "unit" && tok.length >= 4) {
        unitNo = tok[3]; rest = tok.slice(4);
      } else if (tok[1].startsWith("irb.")) {
        unitNo = tok[1].slice(4); rest = tok.slice(2);
      } else {
        continue;
      }
      let unit = units.get(unitNo);
      if (!unit) {
        unit = { description: "", disabled: false, addresses: new Map(), dhcp: [] };
        units.set(unitNo, unit);
      }
      handleIrbUnit(unit, rest);
    } else if (tok[0] === "vlans") {
      handleVlan(tok[1], tok.slice(2));
    } else if (tok[0] === "routing-instances") {
      const ri = tok[1];
      const rest = tok.slice(2);
      if (rest[0] === "interface" && rest.length > 1 && rest[1].startsWith("irb.")) {
        routingInstances[rest[1]] = ri;
      } else if (rest[0] === "vlans" && rest.length > 2) {
        handleVlan(rest[1], rest.slice(2));
      }
    }
  }

  return { units, vlans, routingInstances };
}

/** _unit_sort_key: numeric units first in numeric order, then the rest by name. */
export function unitSortKey(a, b) {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  if (na) return -1;
  if (nb) return 1;
  return a.localeCompare(b);
}
