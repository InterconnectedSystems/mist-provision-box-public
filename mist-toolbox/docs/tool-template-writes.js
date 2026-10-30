// A complete, working tool that MAKES CHANGES to Mist, to copy from.
//
// Read-only tools are best practice; start from tool-template.js unless the
// job really needs to change configuration. This one sets the Notes field of
// one site, or of every site, and shows the pattern every tool that makes
// changes should follow:
//
//   1. writes: true             declares it; the card says "Makes changes"
//   2. a Dry run box, ticked    plan and preview first, change nothing
//   3. check ctx.access         stop early if the token cannot make changes
//   4. ctx.mistWrite            the only way to send a change; logged, never retried
//   5. a sheet of what changed  so the run leaves a record
//
// Mist endpoints: GET /orgs/{org_id}/sites (through ctx.targetSites),
// PUT /sites/{site_id} with { notes }.

export default {
  id: "site-notes",
  name: "Site Notes",
  description: "Sets the Notes field of one site, or of every site in the org. Runs as a "
    + "dry run first, so you can see every change before anything is sent.",
  tag: "Mist API",
  needs: { mistToken: true, org: true },
  scope: "site",
  writes: true,
  params: [
    { id: "notes", label: "Notes", type: "textarea", full: true,
      hint: "The text to put in each site's Notes field." },
    { id: "mode", label: "How", type: "select", default: "replace",
      options: [
        { value: "replace", label: "Replace the existing notes" },
        { value: "append", label: "Add to the end of the existing notes" },
      ] },
    { id: "dryRun", label: "Dry run: show the changes, send nothing", type: "checkbox", default: true },
  ],

  async run(ctx) {
    const { log, params } = ctx;
    const text = String(params.notes || "").trim();
    if (!text) throw new Error("Enter the notes to set.");

    const scope = await ctx.targetSites();
    log(`Scope: ${scope.label}`, "info");

    // 1. Plan: work out every change before sending any.
    const plan = scope.sites.map((s) => {
      const before = String(s.notes || "");
      const after = params.mode === "append" && before ? `${before}\n${text}` : text;
      return { id: s.id, site: s.name || s.id, before, after, action: before === after ? "No change" : "Update" };
    });
    const changes = plan.filter((p) => p.action === "Update");
    log(`${changes.length} of ${plan.length} site(s) would change.`, "info");

    // 2. Dry run, or a token that cannot make changes: stop after the plan.
    let applied = false;
    if (params.dryRun) {
      log("Dry run: nothing was sent. Untick Dry run to apply.", "info");
    } else if (!ctx.access?.canWrite) {
      throw new Error(`Your token cannot make changes in this org (${ctx.access?.label || "permission unknown"}). `
        + "Nothing was sent.");
    } else {
      // 3. Apply, one site at a time, recording each result.
      for (const p of changes) {
        if (ctx.signal.aborted) break;
        try {
          await ctx.mistWrite("PUT", `/sites/${p.id}`, { notes: p.after });
          p.action = "Updated";
          log(`${p.site}: notes updated`, "ok");
        } catch (e) {
          p.action = `Failed: ${e.message}`;
          log(`${p.site}: ${e.message}`, "err");
        }
      }
      applied = true;
    }

    const columns = [
      { header: "Site", key: "site", width: 30 },
      { header: "Result", key: "action", width: 24 },
      { header: "Notes before", key: "before", width: 50, wrap: true },
      { header: "Notes after", key: "after", width: 50, wrap: true },
    ];
    const rows = plan.map((p) => ({
      ...p,
      __style: p.action.startsWith("Failed") ? "red" : p.action === "Updated" ? "green"
        : p.action === "Update" ? "yellow" : undefined,
    }));
    const done = plan.filter((p) => p.action === "Updated").length;
    return {
      summary: applied
        ? `${done} of ${changes.length} site(s) updated`
        : `Dry run: ${changes.length} of ${plan.length} site(s) would be updated`,
      filename: ctx.stampedName(applied ? "mist_site_notes_applied" : "mist_site_notes_plan", scope.fileLabel, "xlsx"),
      sheets: [ctx.xlsx.sheet(applied ? "Changes" : "Planned Changes", columns, rows)],
      preview: { title: applied ? "Changes" : "Planned changes (dry run)", columns, rows },
    };
  },
};
