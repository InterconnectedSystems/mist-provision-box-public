// What the validated token may do in the selected org, from the privileges
// GET /self already returned. The shell shows it next to the org picker and
// hands it to tools as ctx.access, so the "read-only" wording is a fact about
// the token in use rather than a promise about the toolbox.
//
// Mist roles: read = Observer, helpdesk, installer, write = Network Admin,
// admin = Super User. Helpdesk and installer can make some changes.

const RANK = { unknown: 0, read: 1, limited: 2, write: 3, admin: 4 };

const ROLE = {
  read: { level: "read", name: "Observer" },
  helpdesk: { level: "limited", name: "Helpdesk" },
  installer: { level: "limited", name: "Installer" },
  write: { level: "write", name: "Network Admin" },
  admin: { level: "admin", name: "Super User" },
};

const LABEL = {
  read: (n) => `Read-only token (${n})`,
  limited: (n) => `Limited changes (${n})`,
  write: (n) => `Can make changes (${n})`,
  admin: (n) => `Full admin (${n})`,
};

/**
 * @param {Array<object>} privileges  the `privileges` array from GET /self
 * @param {string} orgId              the selected org
 * @returns {{level: "read"|"limited"|"write"|"admin"|"unknown", canWrite: boolean,
 *   roles: string[], label: string, detail: string}}
 */
export function tokenAccess(privileges, orgId) {
  const forOrg = [];
  const forSites = [];
  for (const p of Array.isArray(privileges) ? privileges : []) {
    if (!p || typeof p !== "object" || !ROLE[p.role]) continue;
    if (p.scope === "org" && p.org_id === orgId) forOrg.push(p);
    else if (p.scope === "msp") forOrg.push(p);
    else if (p.scope === "site" && p.org_id === orgId) forSites.push(p);
  }

  const best = (list) => list.reduce((b, p) => (RANK[ROLE[p.role].level] > RANK[b] ? ROLE[p.role].level : b), "unknown");
  const orgLevel = best(forOrg);
  const siteLevel = best(forSites);
  const level = RANK[siteLevel] > RANK[orgLevel] ? siteLevel : orgLevel;
  const roles = [...new Set([...forOrg, ...forSites].map((p) => p.role))];

  if (level === "unknown") {
    return { level, canWrite: false, roles, label: "Permission unknown",
      detail: "Mist listed no recognised role for this org. Tools that make changes may be refused." };
  }
  const nameOf = (lvl, list) => ROLE[list.find((p) => ROLE[p.role].level === lvl).role].name;
  const label = LABEL[level](nameOf(level, RANK[siteLevel] > RANK[orgLevel] ? forSites : forOrg));

  let detail = "";
  if (RANK[siteLevel] > RANK[orgLevel]) {
    const n = forSites.filter((p) => ROLE[p.role].level === siteLevel).length;
    const base = orgLevel === "unknown" ? "No org-wide role" : `${nameOf(orgLevel, forOrg)} for the whole org`;
    detail = `${base}; ${nameOf(siteLevel, forSites)} at ${n} site${n === 1 ? "" : "s"}.`;
  } else if (forSites.length && orgLevel !== "unknown") {
    detail = `${nameOf(orgLevel, forOrg)} for the whole org.`;
  } else if (forOrg.length) {
    detail = forOrg.some((p) => p.scope === "msp")
      ? `${nameOf(orgLevel, forOrg)} through the MSP.` : `${nameOf(orgLevel, forOrg)} for the whole org.`;
  }
  return { level, canWrite: level !== "read", roles, label, detail };
}
