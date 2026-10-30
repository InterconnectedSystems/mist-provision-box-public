// What the token may do in the selected org, from GET /self privileges.

import { strict as assert } from "node:assert";
import test from "node:test";

import { tokenAccess } from "../lib/access.js";

const org = (role, org_id = "org-1") => ({ scope: "org", org_id, role, name: "Acme" });
const site = (role, org_id = "org-1", site_id = "s1") => ({ scope: "site", org_id, site_id, role });

test("each Mist role maps to a level and a plain label", () => {
  const cases = [
    ["read", "read", "Read-only token (Observer)", false],
    ["helpdesk", "limited", "Limited changes (Helpdesk)", true],
    ["installer", "limited", "Limited changes (Installer)", true],
    ["write", "write", "Can make changes (Network Admin)", true],
    ["admin", "admin", "Full admin (Super User)", true],
  ];
  for (const [role, level, label, canWrite] of cases) {
    const a = tokenAccess([org(role)], "org-1");
    assert.deepEqual([a.level, a.label, a.canWrite], [level, label, canWrite], role);
    assert.deepEqual(a.roles, [role]);
  }
});

test("only the selected org counts; another org's admin role does not", () => {
  const privs = [org("read", "org-1"), org("admin", "org-2"), site("write", "org-2")];
  assert.equal(tokenAccess(privs, "org-1").level, "read");
  assert.equal(tokenAccess(privs, "org-2").level, "admin");
});

test("write access at some sites is surfaced, with a count", () => {
  const a = tokenAccess([org("read"), site("write", "org-1", "s1"), site("write", "org-1", "s2")], "org-1");
  assert.equal(a.level, "write");
  assert.equal(a.label, "Can make changes (Network Admin)");
  assert.equal(a.detail, "Observer for the whole org; Network Admin at 2 sites.");
  const only = tokenAccess([site("write")], "org-1");
  assert.equal(only.detail, "No org-wide role; Network Admin at 1 site.");
});

test("an MSP role covers the org", () => {
  const a = tokenAccess([{ scope: "msp", msp_id: "m1", role: "write" }], "org-1");
  assert.equal(a.level, "write");
  assert.equal(a.detail, "Network Admin through the MSP.");
});

test("no recognised role is unknown, not read-only", () => {
  for (const privs of [[], null, [{ scope: "org", org_id: "org-1", role: "mystery" }], [org("read", "org-2")]]) {
    const a = tokenAccess(privs, "org-1");
    assert.equal(a.level, "unknown");
    assert.equal(a.label, "Permission unknown");
    assert.equal(a.canWrite, false);
  }
});
