// Site / org scope for reports.
//
// A tool that declares `scope: "site"` gets two fields the shell draws for it —
// "All sites in the org" and a Site picker — and `ctx.targetSites()`, which
// turns those into the list of sites to report on. Tools never write this UI
// or this logic themselves.
//
// DOM-free: toolbox.js and tests/helpers.mjs both call resolveSites, so tests
// exercise exactly what the extension runs.

export const SCOPE_PARAMS = [
  {
    id: "allSites",
    label: "All sites in the org",
    type: "checkbox",
    default: true,
  },
  {
    id: "siteId",
    label: "Site",
    type: "select",
    optionsFrom: "sites",
    hint: "Untick \"All sites in the org\" to report on one site.",
  },
];

const byName = (a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), undefined, { sensitivity: "base" });

/** The fields a tool's form actually shows, scope fields first. */
export function effectiveParams(tool) {
  return tool.scope === "site" ? [...SCOPE_PARAMS, ...(tool.params || [])] : (tool.params || []);
}

/**
 * Sites to report on.
 * @returns {Promise<{sites: object[], orgSites: object[], all: boolean, label: string, fileLabel: string}>}
 *   `sites` and `orgSites` are full Mist site records, sorted by name.
 */
export async function resolveSites({ getAll, orgId, orgName, params }) {
  const orgSites = (await getAll(`/orgs/${orgId}/sites`))
    .filter((s) => s && typeof s === "object" && s.id)
    .sort(byName);
  // Absent params mean the whole org, which is how every tool behaved before.
  const all = params?.allSites !== false;
  if (all) {
    if (!orgSites.length) throw new Error("This org has no sites.");
    return {
      sites: orgSites, orgSites, all: true,
      label: `all ${orgSites.length} site${orgSites.length === 1 ? "" : "s"}`,
      fileLabel: orgName || orgId,
    };
  }
  if (!params?.siteId) throw new Error("Pick a site, or tick \"All sites in the org\".");
  const site = orgSites.find((s) => s.id === params.siteId);
  if (!site) throw new Error("That site is no longer in this org. Pick another.");
  const name = site.name || site.id;
  return { sites: [site], orgSites, all: false, label: name, fileLabel: `${orgName || orgId}_${name}` };
}

/** The scope chip a tool card shows. */
export function scopeChip(tool) {
  if (tool.level) return tool.level;
  const ids = new Set((tool.params || []).map((p) => p.id));
  if (tool.scope === "site" || (ids.has("allSites") && ids.has("siteId"))) return "Site · Org";
  if (tool.needs?.org) return "Org";
  return "";
}
