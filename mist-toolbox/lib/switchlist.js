// Org switch inventory collapsed to one record per switch or virtual chassis.
// Shared by IP Blocks and Switch Config Export: a VC has one config, so its
// member rows fold onto the VC MAC.

export const safeFilename = (t) => String(t).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "unnamed";

/** build_switch_list: collapse inventory rows into one record per switch or VC. */
export function buildSwitchList(inventory, sitesById) {
  const groups = new Map();
  for (const item of inventory) {
    const mac = (item.mac || "").toLowerCase();
    const key = (item.vc_mac || mac).toLowerCase();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const switches = [];
  for (const [key, members] of groups) {
    const primary = members.find((m) => (m.mac || "").toLowerCase() === key) || members[0];
    const isPrimary = (primary.mac || "").toLowerCase() === key;
    const deviceId = (isPrimary && primary.id) || `00000000-0000-0000-1000-${key}`;
    const siteId = members.find((m) => m.site_id)?.site_id || null;
    const name = primary.name || primary.hostname
      || members.find((m) => m.name)?.name || key;
    const models = [...new Set(members.map((m) => m.model).filter(Boolean))].sort();
    const serials = members.map((m) => m.serial).filter(Boolean);

    switches.push({
      name,
      mac: key,
      model: models.join(", "),
      serials: serials.join(", "),
      members: members.length,
      connected: members.some((m) => m.connected),
      device_id: deviceId,
      site_id: siteId,
      site_name: siteId ? (sitesById[siteId]?.name || "") : "",
      status: "",
      error: "",
      cli_lines: 0,
      irb_units: 0,
      addresses: 0,
    });
  }

  switches.sort((a, b) => a.site_name.toLowerCase().localeCompare(b.site_name.toLowerCase())
    || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return switches;
}
