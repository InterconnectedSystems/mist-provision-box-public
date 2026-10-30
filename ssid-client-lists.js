// SSID Banned / Approved Clients
//
// Gets the live clients on one SSID (one site, or every site in the org),
// lets the user pick clients by attribute (device family, OS, manufacturer…),
// review them, and push the MACs to the Mist banned client list (blacklist)
// or approved client list (whitelist).
//
// Mist API used:
//   GET  /sites/{id}/stats/clients            live wireless clients
//   GET  /sites/{id}/wlans, /wlans/derived    SSIDs at a site
//   GET  /orgs/{id}/wlans                     org (template) SSIDs
//   POST /sites/{id}/setting/blacklist        site banned list   {macs:[...]}
//   POST /sites/{id}/setting/whitelist        site approved list {macs:[...]}
//   POST /orgs/{id}/setting/blacklist         org banned list    {macs:[...]}, max 1000
//   PUT  /sites|orgs/{id}/wlans/{wlan_id}     block_blacklist_clients: true
//
// Each POST replaces the whole list. Mist has no org-level approved list, so
// approved clients in org mode go to each site's list.

const LISTS = {
  banned: { label: "Banned", path: "blacklist", verb: "ban" },
  approved: { label: "Approved", path: "whitelist", verb: "approve" },
};
const ORG_BANNED_MAX = 1000;
const WLAN_ENFORCED_MAX = 256;
const UNKNOWN = "(unknown)";

const BANDS = { "24": "2.4 GHz", "5": "5 GHz", "6": "6 GHz" };

// Attribute groups offered as checkboxes. A group only shows when at least
// one client has a value for it. "_random" and "_site" are worked out here.
const ATTRS = [
  { key: "family", label: "Device family" },
  { key: "manufacture", label: "Manufacturer" },
  { key: "model", label: "Model" },
  { key: "os", label: "Operating system" },
  { key: "os_version", label: "OS version" },
  { key: "_random", label: "MAC address type" },
  { key: "band", label: "Band", fmt: (v) => BANDS[v] || v },
  { key: "proto", label: "Wi-Fi protocol" },
  { key: "key_mgmt", label: "Key management" },
  { key: "vlan_id", label: "VLAN" },
  { key: "is_guest", label: "Guest client" },
  { key: "_site", label: "Site", orgOnly: true },
];

function normMac(s) {
  const h = String(s || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  return h.length === 12 ? h : null;
}

function parseMacs(text) {
  const ok = new Set();
  const bad = [];
  for (const tok of String(text || "").split(/[\s,;]+/)) {
    if (!tok) continue;
    const m = normMac(tok);
    if (m) ok.add(m);
    else bad.push(tok);
  }
  return { ok: [...ok], bad };
}

function normalizeClient(raw, site) {
  const mac = normMac(raw.mac);
  if (!mac) return null;
  const attrs = {};
  for (const at of ATTRS) {
    let v;
    if (at.key === "_random") {
      v = parseInt(mac.slice(0, 2), 16) & 2 ? "Randomised (private)" : "Hardware (universal)";
    } else if (at.key === "_site") {
      v = site.name;
    } else {
      v = raw[at.key];
    }
    if (typeof v === "boolean") v = v ? "Yes" : "No";
    if (v === undefined || v === null || v === "") v = UNKNOWN;
    v = String(v);
    attrs[at.key] = at.fmt && v !== UNKNOWN ? at.fmt(v) : v;
  }
  return {
    mac,
    hostname: raw.hostname || "",
    username: raw.username || "",
    ip: raw.ip || "",
    rssi: raw.rssi,
    siteId: site.id,
    siteName: site.name,
    attrs,
  };
}

const STYLES = `
.bc{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;color:inherit;font:inherit;--acc:#b42318;--acc-bg:rgba(180,35,24,.09)}
.bc[data-list=approved]{--acc:#1a7f37;--acc-bg:rgba(26,127,55,.09)}
.bc *{box-sizing:border-box}
.bc-card{border:1px solid rgba(127,127,127,.35);border-radius:10px;padding:14px 16px}
.bc-card h3{margin:0 0 10px;font-size:15px;display:flex;gap:8px;align-items:center}
.bc-step{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;background:var(--acc);color:#fff;font-size:12px}
.bc-row{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:end}
.bc-field{display:grid;gap:4px;font-size:13px;min-width:200px}
.bc-field.wide{flex:1 1 320px}
.bc,.bc *{text-transform:none!important;letter-spacing:normal!important}
.bc input[type=checkbox],.bc input[type=radio]{all:revert!important;accent-color:var(--acc)!important;width:16px!important;height:16px!important;margin:0!important;flex:none!important;cursor:pointer!important}
.bc-field>span:first-child{font-size:12px;font-weight:600;opacity:.75}
.bc input[type=text],.bc input[type=search],.bc select,.bc textarea{padding:6px 8px;border:1px solid rgba(127,127,127,.55);border-radius:6px;background:transparent;color:inherit;font:inherit;width:100%}
.bc select option{color:#000}
.bc textarea{min-height:70px;font-family:ui-monospace,Consolas,monospace;font-size:12px}
.bc-seg{display:inline-flex;border:1px solid rgba(127,127,127,.55);border-radius:8px;overflow:hidden}
.bc .bc-seg label{padding:6px 14px;cursor:pointer;font-size:13px;display:flex;gap:6px;align-items:center;margin:0}
.bc-seg label+label{border-left:1px solid rgba(127,127,127,.55)}
.bc .bc-seg input[type=radio]{position:absolute!important;opacity:0!important;pointer-events:none!important}
.bc .bc-seg label.on{background:var(--acc);color:#fff}
.bc .bc-seg label:focus-within{outline:2px solid var(--acc);outline-offset:-2px}
.bc-btn{padding:7px 14px;border-radius:6px;border:1px solid rgba(127,127,127,.55);background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:13px}
.bc-btn.primary{background:#1f4e78;border-color:#1f4e78;color:#fff}
.bc-btn.danger{background:var(--acc);border-color:var(--acc);color:#fff}
.bc-btn:disabled{opacity:.45;cursor:not-allowed}
.bc-note{border-left:4px solid #c98a00;background:rgba(201,138,0,.12);padding:8px 12px;border-radius:6px;font-size:13px;line-height:1.45}
.bc-note.info{border-color:#2f6fb0;background:rgba(47,111,176,.10)}
.bc-note.err{border-color:#b42318;background:rgba(180,35,24,.10)}
.bc-note.ok{border-color:#1a7f37;background:rgba(26,127,55,.10)}
.bc-note ul{margin:4px 0 0;padding-left:18px}
.bc-muted{opacity:.7;font-size:12.5px}
.bc-hidden{display:none!important}
.bc-bar{height:6px;border-radius:3px;background:rgba(127,127,127,.25);overflow:hidden;flex:1 1 200px}
.bc-bar>div{height:100%;width:0;background:#1f4e78;transition:width .2s}
.bc .bc-opt{display:flex;gap:8px;align-items:center;font-size:13px;cursor:pointer;margin:0}
.bc-selbar{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;padding:10px 14px;border-radius:8px;border:1px solid var(--acc);background:var(--acc-bg);margin-bottom:6px}
.bc-selbar .bc-big{font-size:22px}
.bc-chips{display:flex;flex-wrap:wrap;gap:6px;flex:1 1 300px}
.bc-facet{display:grid;grid-template-columns:180px 1fr;gap:6px 16px;align-items:start;padding:10px 2px;border-top:1px solid rgba(127,127,127,.2)}
.bc-facet-name{font-weight:600;font-size:13px;padding-top:4px}
.bc-facet-name small{display:block;font-weight:400;font-size:11.5px;opacity:.65;margin-top:2px}
.bc-facet-name a{color:inherit;cursor:pointer}
.bc-pills{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.bc .bc-pill{display:inline-flex;align-items:center;gap:7px;padding:4px 5px 4px 11px;margin:0;min-width:0;height:auto;border-radius:999px;border:1px solid rgba(127,127,127,.45);background:transparent;color:inherit;font:inherit;font-size:12.5px;line-height:1.3;cursor:pointer;box-shadow:none;text-align:left;white-space:nowrap}
.bc .bc-pill:hover{border-color:var(--acc)}
.bc .bc-pill:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
.bc .bc-pill .n{font-size:11px;padding:1px 7px;border-radius:999px;background:rgba(127,127,127,.2);font-variant-numeric:tabular-nums}
.bc .bc-pill[aria-pressed=true]{background:var(--acc);border-color:var(--acc);color:#fff}
.bc .bc-pill[aria-pressed=true] .n{background:rgba(255,255,255,.25)}
.bc .bc-pill.zero{opacity:.4}
.bc .bc-pill.unk{font-style:italic}
.bc .bc-pill.more{border-style:dashed;padding-right:11px;opacity:.85}
.bc .bc-pill.chip{padding:3px 10px;background:var(--acc);border-color:var(--acc);color:#fff}
.bc .bc-pill.chip:hover{opacity:.85}
.bc .bc-vfilter{width:190px!important;padding:3px 8px!important;font-size:12px!important;border-radius:999px!important}
.bc-same{border-top:1px solid rgba(127,127,127,.2);padding-top:8px}
.bc-same>summary{cursor:pointer;font-size:12.5px;opacity:.8;padding:4px 2px}
@media (max-width:640px){.bc-facet{grid-template-columns:1fr}}
.bc-sum{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:10px}
.bc-big{font-size:20px;font-weight:700;color:var(--acc)}
.bc-tbl{max-height:620px;overflow:auto;border:1px solid rgba(127,127,127,.35);border-radius:8px}
.bc-tbl table{font-size:13px}
.bc-tbl thead th{position:sticky;top:0;z-index:1;background:var(--bc-bg,Canvas);color:inherit;border-bottom:2px solid rgba(127,127,127,.45);white-space:nowrap;cursor:pointer;user-select:none}
.bc-tbl thead th.ck{cursor:default;width:34px}
.bc-tbl td{white-space:nowrap}
.bc-tbl tbody tr{cursor:pointer}
.bc-tbl tbody tr:nth-child(even){background:rgba(127,127,127,.05)}
.bc-tbl tbody tr.on td:first-child{box-shadow:inset 3px 0 0 var(--acc)}
.bc-tbl tbody tr.off td{opacity:.45;text-decoration:line-through}
.bc-tbl tbody tr.off td:first-child{text-decoration:none;opacity:1}
.bc-tbl tbody tr:hover{background:var(--acc-bg)}
.bc-tbl input{accent-color:var(--acc);margin:0}
.bc-mono{font-family:ui-monospace,Consolas,monospace}
.bc-list{border:1px solid rgba(127,127,127,.35);border-radius:8px;margin-bottom:8px}
.bc-list>summary{padding:8px 12px;cursor:pointer;display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;font-size:13px}
.bc-list>summary b{font-size:14px}
.bc-list>.bc-body{padding:0 12px 10px}
.bc-tag{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11.5px;font-weight:600;color:#fff;background:#b42318}
.bc-tag.approved{background:#1a7f37}
.bc table{border-collapse:collapse;width:100%;font-size:12.5px}
.bc th,.bc td{border-bottom:1px solid rgba(127,127,127,.25);padding:5px 8px;text-align:left;vertical-align:top}
.bc th{font-weight:600}
.bc td.num,.bc th.num{text-align:right;font-variant-numeric:tabular-nums}
.bc-scroll{max-height:360px;overflow:auto}
`;

const HTML = `
<div class="bc" data-list="banned">
  <style>${STYLES}</style>

  <div class="bc-card">
    <h3><span class="bc-step">1</span> Where to look</h3>
    <div class="bc-row" style="margin-bottom:12px">
      <div class="bc-field" style="min-width:0">
        <span>List to build</span>
        <div class="bc-seg" data-bc="listSeg">
          <label class="on"><input type="radio" name="bc-list" value="banned" checked> Banned clients</label>
          <label><input type="radio" name="bc-list" value="approved"> Approved clients</label>
        </div>
      </div>
      <div class="bc-field" style="min-width:0">
        <span>Query</span>
        <div class="bc-seg" data-bc="scopeSeg">
          <label class="on"><input type="radio" name="bc-scope" value="site" checked> One site</label>
          <label><input type="radio" name="bc-scope" value="org"> Whole org</label>
        </div>
      </div>
    </div>
    <div class="bc-row">
      <label class="bc-field" data-bc="siteWrap"><span>Site</span><select data-bc="site"><option value="">Loading sites…</option></select></label>
      <label class="bc-field"><span>SSID (exact name)</span><input type="text" data-bc="ssid" list="bc-ssids" placeholder="Pick or type an SSID"><datalist id="bc-ssids" data-bc="ssidList"></datalist></label>
      <button class="bc-btn primary" data-bc="getBtn">Get live clients</button>
      <button class="bc-btn bc-hidden" data-bc="cancelBtn">Cancel</button>
    </div>
    <div class="bc-row" style="margin-top:10px">
      <div class="bc-bar bc-hidden" data-bc="bar"><div></div></div>
      <span class="bc-muted" data-bc="status"></span>
    </div>
    <div class="bc-note bc-hidden" data-bc="orgNotice" style="margin-top:12px">
      <b>Whole-org queries do not show the per-client list.</b> An org can have
      well over 10,000 live clients, which is too many to tick through one by one.
      In org mode you still choose clients by attribute and see how many match at
      each site; you can download the matched MACs as CSV to check them, and paste
      MACs to leave out. The full client list with a checkbox per client is only
      shown for a <b>single-site</b> query, and it is never cut short there.
    </div>
    <div class="bc-note info" style="margin-top:12px">
      <b>How Mist applies these lists</b>
      <ul>
        <li>Mist keeps <b>one banned list per site and one per org</b>, not one per SSID. The SSID here picks which clients to look at. A banned client is refused on every SSID that has <i>Prevent banned clients from associating</i> turned on; this tool can turn that on for the chosen SSID.</li>
        <li>A WLAN enforces only the first ${WLAN_ENFORCED_MAX} banned MACs. The org banned list holds at most ${ORG_BANNED_MAX}.</li>
        <li>Mist has no org-level approved list, so approved clients in org mode are pushed to each site's list.</li>
        <li><b>Pushing replaces the whole list.</b> Paste MACs already on the list into <i>Extra MACs</i> (step 4) to keep them.</li>
      </ul>
    </div>
  </div>

  <div class="bc-card bc-hidden" data-bc="attrCard">
    <h3><span class="bc-step">2</span> Choose clients by attribute</h3>
    <div class="bc-selbar">
      <div><span class="bc-big" data-bc="matchCount">0</span> <span data-bc="matchOf"></span></div>
      <div class="bc-chips" data-bc="chips"></div>
      <button class="bc-btn" data-bc="clearAttrs">Clear all</button>
    </div>
    <p class="bc-muted" style="margin:0 0 4px">Click values to select clients. Values in one row mean <i>any of these</i> (Apple or Samsung); values in different rows must <i>all</i> match (Apple and iOS). Each number is how many clients that value matches alongside your other choices.</p>
    <div class="bc-facet">
      <div class="bc-facet-name">Name contains<small>hostname, username or MAC</small></div>
      <div><input type="text" data-bc="text" placeholder="e.g. android- or a4:83:e7" style="max-width:420px"></div>
    </div>
    <div data-bc="groups"></div>
  </div>

  <div class="bc-card bc-hidden" data-bc="reviewCard">
    <h3><span class="bc-step">3</span> <span data-bc="reviewTitle">Review selected clients</span></h3>
    <div data-bc="review"></div>
  </div>

  <div class="bc-card bc-hidden" data-bc="pushCard">
    <h3><span class="bc-step">4</span> <span data-bc="pushTitle">Push to Mist</span></h3>
    <div class="bc-row">
      <label class="bc-field bc-hidden" data-bc="targetWrap"><span>Push to</span>
        <select data-bc="target">
          <option value="org">The org banned list (one list, max ${ORG_BANNED_MAX})</option>
          <option value="sites">Each site's banned list (that site's matches)</option>
        </select>
      </label>
      <label class="bc-field wide"><span>Extra MACs to include (one per line, any format)</span>
        <textarea data-bc="extra" placeholder="aa:bb:cc:dd:ee:ff"></textarea>
      </label>
    </div>
    <p class="bc-muted" data-bc="extraHint" style="margin:6px 0 0"></p>
    <label class="bc-opt" data-bc="enforceWrap" style="margin-top:10px"><input type="checkbox" data-bc="enforce" checked> <span data-bc="enforceText"></span></label>
    <div class="bc-row" style="margin-top:12px">
      <button class="bc-btn primary" data-bc="planBtn">Review changes</button>
      <span class="bc-muted" data-bc="access"></span>
    </div>
    <div data-bc="plan" style="margin-top:12px"></div>
  </div>

  <div class="bc-card">
    <h3>Current banned &amp; approved clients in Mist</h3>
    <p class="bc-muted" style="margin:0 0 10px">Lists what is on the banned and approved lists right now, for the site or whole org chosen in step 1. The org banned list is always included because it applies at every site. Hostnames and device details come from the last <i>Get live clients</i> query, so MACs not online on that SSID show only the MAC.</p>
    <div class="bc-row">
      <button class="bc-btn primary" data-bc="checkBtn">Check banned &amp; approved clients</button>
      <button class="bc-btn bc-hidden" data-bc="checkCsv">Download lists (CSV)</button>
      <span class="bc-muted" data-bc="checkStatus"></span>
    </div>
    <div data-bc="current" style="margin-top:12px"></div>
  </div>
</div>`;

export default {
  id: "ssid-client-lists",
  name: "SSID Banned / Approved Clients",
  description:
    "Get the live clients on one SSID for a site or the whole org, pick them by device family, OS, manufacturer and more, review them, then push their MACs to the Mist banned or approved client list.",
  tag: "Mist API",
  level: "Site · Org",
  notice:
    "Shows client MAC addresses, hostnames and usernames (personal data). Pushing a list replaces the existing banned or approved list for that site or org in Mist.",
  needs: { mistToken: true, org: true },
  writes: true,

  async run() {
    throw new Error("This tool draws its own view. Use the panel below the description.");
  },

  async mount(ctx) {
    const root = ctx.mount;
    root.innerHTML = HTML;
    const $ = (id) => root.querySelector(`[data-bc="${id}"]`);
    const esc = ctx.esc;

    // Sticky table headers need a solid background: borrow the toolbox's own.
    for (let el = root; el && el.nodeType === 1; el = el.parentElement) {
      const bg = getComputedStyle(el).backgroundColor;
      if (bg && bg !== "transparent" && !/^rgba\(.*,\s*0\)$/.test(bg)) {
        root.firstElementChild.style.setProperty("--bc-bg", bg);
        break;
      }
    }

    const S = {
      list: "banned",
      scope: "site",
      sites: [],
      orgWlans: [],
      // what the last "Get live clients" found
      query: null, // { scope, siteId, siteName, ssid }
      clients: [],
      ssidCounts: new Map(),
      wlans: [], // [{ where: "site"|"org", siteId, siteName, id, ssid, blocked }]
      failedSites: [],
      checked: {},
      expanded: new Set(), // attributes showing all their values
      vfilter: {}, // "Find a value" text per attribute
      sameOpen: false,
      text: "",
      excluded: new Set(),
      orgExclude: new Set(),
      busy: false,
      cancel: false,
      plan: null,
    };

    const setStatus = (t) => {
      $("status").textContent = t || "";
      if (typeof ctx.status === "function") ctx.status(t || "");
    };
    const setProgress = (done, total) => {
      $("bar").classList.toggle("bc-hidden", !total);
      $("bar").firstElementChild.style.width = total ? `${Math.round((done / total) * 100)}%` : "0";
      if (typeof ctx.progress === "function" && total) ctx.progress(done, total, "sites");
    };
    const site = (id) => S.sites.find((s) => s.id === id);

    // ---- step 1: where -------------------------------------------------

    function setSeg(segId, value) {
      for (const lab of $(segId).querySelectorAll("label")) {
        lab.classList.toggle("on", lab.querySelector("input").value === value);
      }
    }

    $("listSeg").addEventListener("change", (e) => {
      S.list = e.target.value;
      setSeg("listSeg", S.list);
      root.firstElementChild.dataset.list = S.list;
      S.plan = null;
      renderReview();
      renderPush();
    });

    $("scopeSeg").addEventListener("change", (e) => {
      S.scope = e.target.value;
      setSeg("scopeSeg", S.scope);
      $("siteWrap").classList.toggle("bc-hidden", S.scope === "org");
      $("orgNotice").classList.toggle("bc-hidden", S.scope !== "org");
      fillSsidList();
    });

    $("site").addEventListener("change", fillSsidList);

    async function fillSsidList() {
      const names = new Set(S.orgWlans.map((w) => w.ssid).filter(Boolean));
      const sid = $("site").value;
      if (S.scope === "site" && sid) {
        try {
          const derived = await ctx.getAll(`/sites/${sid}/wlans/derived`);
          names.clear();
          for (const w of derived) if (w.ssid) names.add(w.ssid);
        } catch (err) {
          ctx.log(`Could not list SSIDs for the site: ${err.message}`, "err");
        }
      }
      $("ssidList").innerHTML = [...names].sort().map((n) => `<option value="${esc(n)}"></option>`).join("");
    }

    async function init() {
      try {
        S.sites = await ctx.listSites();
        $("site").innerHTML =
          `<option value="">Choose a site…</option>` +
          S.sites.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
      } catch (err) {
        $("site").innerHTML = `<option value="">Could not load sites</option>`;
        ctx.log(`Could not load sites: ${err.message}`, "err");
      }
      try {
        S.orgWlans = await ctx.getAll(`/orgs/${ctx.orgId}/wlans`);
      } catch (err) {
        ctx.log(`Could not list org SSIDs: ${err.message}`, "err");
      }
      fillSsidList();
      renderAccess();
    }

    function renderAccess() {
      const a = ctx.access;
      $("access").textContent = a ? `Token: ${a.label || a.level}` : "";
    }

    $("cancelBtn").addEventListener("click", () => {
      S.cancel = true;
      setStatus("Cancelling…");
    });

    $("getBtn").addEventListener("click", getClients);

    async function getClients() {
      if (S.busy) return;
      const ssid = $("ssid").value.trim();
      const sid = $("site").value;
      if (!ssid) return setStatus("Enter the SSID first.");
      if (S.scope === "site" && !sid) return setStatus("Choose a site first.");

      S.busy = true;
      S.cancel = false;
      $("getBtn").disabled = true;
      $("cancelBtn").classList.remove("bc-hidden");
      S.plan = null;
      $("plan").innerHTML = "";

      try {
        const sites = S.scope === "site" ? [site(sid)] : S.sites;
        const clients = [];
        const ssidCounts = new Map();
        const wlans = [];
        const failed = [];
        let done = 0;
        setProgress(0, sites.length);
        setStatus(`Getting live clients from ${sites.length === 1 ? sites[0].name : `${sites.length} sites`}…`);

        const orgWlanIds = new Set(S.orgWlans.map((w) => w.id));
        const jobs = sites.map((s) => async () => {
          if (S.cancel) return;
          try {
            const [raw, own, derived] = await Promise.all([
              ctx.getAll(`/sites/${s.id}/stats/clients`, { limit: 1000 }),
              ctx.getAll(`/sites/${s.id}/wlans`),
              S.scope === "site" ? ctx.getAll(`/sites/${s.id}/wlans/derived`) : Promise.resolve([]),
            ]);
            for (const c of raw) {
              ssidCounts.set(c.ssid || UNKNOWN, (ssidCounts.get(c.ssid || UNKNOWN) || 0) + 1);
              if (c.ssid !== ssid) continue;
              const n = normalizeClient(c, s);
              if (n) clients.push(n);
            }
            for (const w of own) {
              if (w.ssid === ssid) {
                wlans.push({ where: "site", siteId: s.id, siteName: s.name, id: w.id, ssid: w.ssid, blocked: !!w.block_blacklist_clients });
              }
            }
            // A derived WLAN that is not the site's own comes from an org template.
            const ownIds = new Set(own.map((w) => w.id));
            for (const w of derived) {
              if (w.ssid === ssid && !ownIds.has(w.id) && orgWlanIds.has(w.id)) {
                wlans.push({ where: "org", id: w.id, ssid: w.ssid, blocked: !!w.block_blacklist_clients });
              }
            }
          } catch (err) {
            failed.push(s.name);
            ctx.log(`${s.name}: ${err.message}`, "err");
          } finally {
            done += 1;
            setProgress(done, sites.length);
            if (sites.length > 1) setStatus(`Sites done: ${done} of ${sites.length} · ${clients.length.toLocaleString()} clients on ${ssid} so far`);
          }
        });
        await ctx.pool(ctx.POOL_LIMIT, jobs);

        if (S.scope === "org") {
          for (const w of S.orgWlans) {
            if (w.ssid === ssid) wlans.push({ where: "org", id: w.id, ssid: w.ssid, blocked: !!w.block_blacklist_clients });
          }
        }
        const seen = new Set();
        S.wlans = wlans.filter((w) => {
          const k = `${w.where}:${w.siteId || ""}:${w.id}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });

        S.query = {
          scope: S.scope,
          siteId: S.scope === "site" ? sid : null,
          siteName: S.scope === "site" ? site(sid).name : ctx.orgName,
          ssid,
          cancelled: S.cancel,
        };
        S.clients = clients.sort((a, b) => (a.hostname || a.mac).localeCompare(b.hostname || b.mac));
        S.ssidCounts = ssidCounts;
        S.failedSites = failed;
        S.checked = {};
        S.expanded = new Set();
        S.vfilter = {};
        S.text = "";
        $("text").value = "";
        S.excluded = new Set();
        S.orgExclude = new Set();

        const where = S.query.scope === "site" ? S.query.siteName : `${sites.length} sites`;
        const msg = `${clients.length.toLocaleString()} live clients on "${ssid}" at ${where}` +
          (failed.length ? ` · ${failed.length} site(s) failed` : "") +
          (S.cancel ? " · cancelled, results are partial" : "");
        setStatus(msg);
        ctx.log(msg, failed.length || S.cancel ? "err" : "ok");
        renderAll();
      } catch (err) {
        setStatus(`Failed: ${err.message}`);
        ctx.log(err.message, "err");
      } finally {
        S.busy = false;
        $("getBtn").disabled = false;
        $("cancelBtn").classList.add("bc-hidden");
        setProgress(0, 0);
      }
    }

    // ---- step 2: attributes -----------------------------------------------

    function groupsForScope() {
      return ATTRS.filter((a) => !a.orgOnly || S.query.scope === "org");
    }

    // Long value lists show the most common PILL_CAP values plus "+N more".
    const PILL_CAP = 10;
    const valueText = (v) => (v === UNKNOWN ? "Unknown" : v);

    // Returns test(client, skipKey): does the client pass every active choice,
    // ignoring the attribute skipKey? Skipping one attribute gives the
    // "how many would match if I add this value" counts on the pills.
    function makeTest() {
      const groups = groupsForScope().filter((a) => S.checked[a.key] && S.checked[a.key].size);
      const txt = S.text.trim().toLowerCase();
      const txtMac = txt.replace(/[^0-9a-f]/g, "");
      return (c, skipKey) => {
        for (const g of groups) if (g.key !== skipKey && !S.checked[g.key].has(c.attrs[g.key])) return false;
        if (!txt) return true;
        return `${c.hostname} ${c.username}`.toLowerCase().includes(txt) || (txtMac.length >= 2 && c.mac.includes(txtMac));
      };
    }

    function hasChoice() {
      return !!S.text.trim() || Object.values(S.checked).some((s) => s.size);
    }

    function facetRow(f) {
      const key = f.at.key;
      const sel = S.checked[key] || new Set();
      const capped = f.values.length > PILL_CAP + 2;
      const open = S.expanded.has(key);
      let hidden = 0;
      const pills = f.values.map((x, i) => {
        const cap = capped && i >= PILL_CAP && !sel.has(x.v);
        if (cap) hidden += 1;
        const on = sel.has(x.v);
        return `<button type="button" class="bc-pill${x.n || on ? "" : " zero"}${x.v === UNKNOWN ? " unk" : ""}${cap && !open ? " bc-hidden" : ""}"` +
          ` data-attr="${esc(key)}" data-val="${esc(x.v)}"${cap ? " data-cap" : ""} aria-pressed="${on}"` +
          ` title="${esc(valueText(x.v))}: ${x.n.toLocaleString()} with your other choices, ${x.total.toLocaleString()} in total">` +
          `${esc(valueText(x.v))}<span class="n">${x.n.toLocaleString()}</span></button>`;
      }).join("");
      const more = hidden
        ? `<button type="button" class="bc-pill more" data-more="${esc(key)}">${open ? "Show fewer" : `+${hidden} more`}</button>`
        : "";
      const find = capped
        ? `<input type="search" class="bc-vfilter" data-vf="${esc(key)}" placeholder="Find a value…" value="${esc(S.vfilter[key] || "")}">`
        : "";
      return `<div class="bc-facet" data-facet="${esc(key)}"><div class="bc-facet-name">${esc(f.at.label)}` +
        (sel.size ? `<small>${sel.size} chosen · <a data-clear="${esc(key)}">clear</a></small>` : `<small>${f.values.length} value${f.values.length === 1 ? "" : "s"}</small>`) +
        `</div><div class="bc-pills">${find}${pills}${more}</div></div>`;
    }

    // Hide or show pills in one row to match its "Find a value" box.
    function applyValueFilter(key) {
      const row = $("groups").querySelector(`[data-facet="${CSS.escape(key)}"]`);
      if (!row) return;
      const q = (S.vfilter[key] || "").trim().toLowerCase();
      for (const p of row.querySelectorAll(".bc-pill[data-attr]")) {
        const hit = p.dataset.val.toLowerCase().includes(q) || valueText(p.dataset.val).toLowerCase().includes(q);
        p.classList.toggle("bc-hidden", q ? !hit : p.hasAttribute("data-cap") && !S.expanded.has(key));
      }
      const more = row.querySelector("[data-more]");
      if (more) more.classList.toggle("bc-hidden", !!q);
    }

    function renderAttrs(focus) {
      const test = makeTest();
      const facets = [];
      for (const at of groupsForScope()) {
        const totals = new Map();
        const live = new Map();
        for (const c of S.clients) {
          const v = c.attrs[at.key];
          totals.set(v, (totals.get(v) || 0) + 1);
          if (test(c, at.key)) live.set(v, (live.get(v) || 0) + 1);
        }
        if (![...totals.keys()].some((v) => v !== UNKNOWN)) continue;
        const values = [...totals.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([v, total]) => ({ v, total, n: live.get(v) || 0 }));
        facets.push({ at, values });
      }
      // Attributes where every client has the same value rarely help, so they sit in a fold.
      const main = facets.filter((f) => f.values.length > 1);
      const same = facets.filter((f) => f.values.length === 1);
      const sameOpen = S.sameOpen || same.some((f) => S.checked[f.at.key] && S.checked[f.at.key].size);
      $("groups").innerHTML =
        main.map(facetRow).join("") +
        (same.length
          ? `<details class="bc-same"${sameOpen ? " open" : ""}><summary>${same.length} more attribute${same.length === 1 ? " has" : "s have"} the same value for every client: ` +
            same.map((f) => `${esc(f.at.label)} <b>${esc(valueText(f.values[0].v))}</b>`).join(" · ") +
            `</summary>${same.map(facetRow).join("")}</details>`
          : "") ||
        `<p class="bc-muted">No attributes to choose from.</p>`;
      const det = $("groups").querySelector(".bc-same");
      if (det) det.addEventListener("toggle", () => (S.sameOpen = det.open));
      for (const key of Object.keys(S.vfilter)) applyValueFilter(key);
      if (focus) {
        const el = $("groups").querySelector(focus);
        if (el) el.focus();
      }
      renderSelbar();
    }

    function renderSelbar() {
      const m = hasChoice() ? matches().length : 0;
      $("matchCount").textContent = m.toLocaleString();
      $("matchOf").textContent = `of ${S.clients.length.toLocaleString()} clients selected`;
      const chips = [];
      for (const at of groupsForScope()) {
        for (const v of S.checked[at.key] || []) {
          chips.push(`<button type="button" class="bc-pill chip" data-rm-attr="${esc(at.key)}" data-rm-val="${esc(v)}" title="Remove">${esc(at.label)}: ${esc(valueText(v))} ✕</button>`);
        }
      }
      if (S.text.trim()) chips.push(`<button type="button" class="bc-pill chip" data-rm-text title="Remove">Name contains “${esc(S.text.trim())}” ✕</button>`);
      $("chips").innerHTML = chips.join("") || `<span class="bc-muted">Nothing chosen yet. Click a value below to start.</span>`;
      $("clearAttrs").disabled = !chips.length;
    }

    function selectionChanged(focus) {
      S.plan = null;
      renderAttrs(focus);
      renderReview();
      renderPush();
    }

    $("groups").addEventListener("click", (e) => {
      const pill = e.target.closest("[data-attr]");
      if (pill) {
        const key = pill.dataset.attr;
        const v = pill.dataset.val;
        const set = S.checked[key] || (S.checked[key] = new Set());
        if (set.has(v)) set.delete(v);
        else set.add(v);
        return selectionChanged(`[data-attr="${CSS.escape(key)}"][data-val="${CSS.escape(v)}"]`);
      }
      const more = e.target.closest("[data-more]");
      if (more) {
        const key = more.dataset.more;
        if (S.expanded.has(key)) S.expanded.delete(key);
        else S.expanded.add(key);
        return renderAttrs(`[data-more="${CSS.escape(key)}"]`);
      }
      const clear = e.target.closest("[data-clear]");
      if (clear) {
        delete S.checked[clear.dataset.clear];
        selectionChanged();
      }
    });

    $("groups").addEventListener("input", (e) => {
      const key = e.target.dataset.vf;
      if (!key) return;
      S.vfilter[key] = e.target.value;
      applyValueFilter(key);
    });

    $("chips").addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      if (chip.hasAttribute("data-rm-text")) {
        S.text = "";
        $("text").value = "";
      } else {
        const set = S.checked[chip.dataset.rmAttr];
        if (set) set.delete(chip.dataset.rmVal);
      }
      selectionChanged();
    });

    let textTimer = null;
    $("text").addEventListener("input", () => {
      clearTimeout(textTimer);
      textTimer = setTimeout(() => {
        S.text = $("text").value;
        selectionChanged();
      }, 200);
    });

    $("clearAttrs").addEventListener("click", () => {
      S.checked = {};
      S.text = "";
      $("text").value = "";
      selectionChanged();
    });

    function matches() {
      if (!hasChoice()) return [];
      const test = makeTest();
      return S.clients.filter((c) => test(c));
    }

    // MACs that will go to Mist, grouped by site, after exclusions.
    function selectedBySite() {
      const out = new Map();
      for (const c of matches()) {
        if (S.query.scope === "site" ? S.excluded.has(c.mac) : S.orgExclude.has(c.mac)) continue;
        if (!out.has(c.siteId)) out.set(c.siteId, new Set());
        out.get(c.siteId).add(c.mac);
      }
      return out;
    }

    function selectedMacs() {
      const all = new Set();
      for (const set of selectedBySite().values()) for (const m of set) all.add(m);
      return all;
    }

    // ---- step 3: review ----------------------------------------------------

    // Columns of the site client table. Click a header to sort.
    const COLS = [
      { label: "Hostname", get: (c) => c.hostname },
      { label: "MAC", get: (c) => ctx.fmtMac(c.mac), mono: true },
      { label: "IP", get: (c) => c.ip, mono: true },
      { label: "Username", get: (c) => c.username },
      { label: "Family", get: (c) => c.attrs.family },
      { label: "Manufacturer", get: (c) => c.attrs.manufacture },
      { label: "Model", get: (c) => c.attrs.model },
      { label: "OS", get: (c) => c.attrs.os },
      { label: "OS version", get: (c) => c.attrs.os_version },
      { label: "Band", get: (c) => c.attrs.band },
      { label: "VLAN", get: (c) => c.attrs.vlan_id },
      { label: "MAC type", get: (c) => c.attrs._random.split(" ")[0] },
    ];
    const cell = (v) => (v === UNKNOWN ? "" : v || "");
    let sortCol = 0;
    let sortDir = 1;

    function clientRow(c) {
      const on = !S.excluded.has(c.mac);
      return (
        `<tr class="${on ? "on" : "off"}" data-mac="${esc(c.mac)}">` +
        `<td><input type="checkbox" data-mac="${esc(c.mac)}"${on ? " checked" : ""} aria-label="Include ${esc(ctx.fmtMac(c.mac))}"></td>` +
        COLS.map((col) => `<td${col.mono ? ` class="bc-mono"` : ""}>${esc(cell(col.get(c)))}</td>`).join("") +
        `</tr>`
      );
    }

    function renderReview() {
      if (!S.query) return;
      const label = LISTS[S.list].label.toLowerCase();
      const m = matches();
      $("reviewTitle").textContent = `Review clients to ${LISTS[S.list].verb}`;

      if (!S.clients.length) {
        const other = [...S.ssidCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
        $("review").innerHTML =
          `<div class="bc-note">No live clients on <b>${esc(S.query.ssid)}</b>. The SSID name must match exactly (it is case sensitive).` +
          (other.length ? `<br>SSIDs with live clients: ${other.map(([s, n]) => `${esc(s)} (${n})`).join(", ")}` : "") +
          `</div>`;
        return;
      }
      if (!m.length) {
        $("review").innerHTML = `<p class="bc-muted">Click at least one value in step 2, or type in <i>Name contains</i>, to select clients.</p>`;
        return;
      }

      if (S.query.scope === "site") renderSiteReview(m, label);
      else renderOrgReview(m, label);
    }

    function renderSiteReview(m, label) {
      $("review").innerHTML =
        `<div class="bc-sum"><span class="bc-big" data-bc="selCount"></span>` +
        `<span class="bc-muted">Every matching client is listed (no limit). Untick any client to keep it off the ${esc(label)} list.</span></div>` +
        `<div class="bc-row" style="margin-bottom:10px">` +
        `<label class="bc-field wide"><span>Filter the table</span><input type="search" data-bc="rowFilter" placeholder="hostname, MAC, model…"></label>` +
        `<button class="bc-btn" data-bc="allOn">Tick all shown</button>` +
        `<button class="bc-btn" data-bc="allOff">Untick all shown</button></div>` +
        `<div class="bc-tbl"><table><thead><tr>` +
        `<th class="ck"><input type="checkbox" data-bc="headBox" aria-label="Tick or untick all shown"></th>` +
        COLS.map((col, i) => `<th data-col="${i}">${esc(col.label)}<span data-arrow></span></th>`).join("") +
        `</tr></thead><tbody data-bc="rows"></tbody></table></div>`;

      const tbody = $("rows");
      const rows = () => [...tbody.children];
      const shown = () => rows().filter((r) => !r.classList.contains("bc-hidden"));

      const setRow = (tr, on) => {
        tr.querySelector("input").checked = on;
        tr.classList.toggle("on", on);
        tr.classList.toggle("off", !on);
        if (on) S.excluded.delete(tr.dataset.mac);
        else S.excluded.add(tr.dataset.mac);
      };
      const changed = () => {
        const vis = shown();
        const n = vis.filter((r) => r.classList.contains("on")).length;
        $("headBox").checked = !!vis.length && n === vis.length;
        $("headBox").indeterminate = n > 0 && n < vis.length;
        S.plan = null;
        updateSelCount();
        renderPush();
      };
      const applyFilter = () => {
        const q = $("rowFilter").value.trim().toLowerCase();
        for (const tr of rows()) tr.classList.toggle("bc-hidden", !!q && !tr.textContent.toLowerCase().includes(q));
      };
      const drawRows = () => {
        const col = COLS[sortCol];
        const sorted = [...m].sort((a, b) =>
          sortDir * String(cell(col.get(a))).localeCompare(String(cell(col.get(b))), undefined, { numeric: true }));
        tbody.innerHTML = sorted.map(clientRow).join("");
        for (const th of root.querySelectorAll(".bc-tbl th[data-col]")) {
          th.querySelector("[data-arrow]").textContent = Number(th.dataset.col) === sortCol ? (sortDir > 0 ? " ▲" : " ▼") : "";
        }
        applyFilter();
        changed();
      };
      drawRows();

      tbody.addEventListener("click", (e) => {
        const tr = e.target.closest("tr");
        if (!tr) return;
        // A click on the checkbox toggles it already; a click elsewhere on the row toggles it here.
        setRow(tr, e.target.matches("input") ? e.target.checked : !tr.querySelector("input").checked);
        changed();
      });

      root.querySelector(".bc-tbl thead").addEventListener("click", (e) => {
        const th = e.target.closest("th[data-col]");
        if (!th) return;
        const i = Number(th.dataset.col);
        sortDir = i === sortCol ? -sortDir : 1;
        sortCol = i;
        drawRows();
      });

      const tickShown = (on) => {
        for (const tr of shown()) setRow(tr, on);
        changed();
      };
      $("headBox").addEventListener("change", (e) => tickShown(e.target.checked));
      $("rowFilter").addEventListener("input", () => {
        applyFilter();
        changed();
      });
      $("allOn").addEventListener("click", () => tickShown(true));
      $("allOff").addEventListener("click", () => tickShown(false));
    }

    function updateSelCount() {
      const el = $("selCount");
      if (!el) return;
      const m = matches();
      const n = selectedMacs().size;
      el.textContent = `${n.toLocaleString()} of ${m.length.toLocaleString()} matching clients selected`;
    }

    function renderOrgReview(m, label) {
      const bySite = new Map();
      for (const c of m) {
        const row = bySite.get(c.siteId) || { name: c.siteName, matched: 0, excluded: 0 };
        row.matched += 1;
        if (S.orgExclude.has(c.mac)) row.excluded += 1;
        bySite.set(c.siteId, row);
      }
      const liveBySite = new Map();
      for (const c of S.clients) liveBySite.set(c.siteId, (liveBySite.get(c.siteId) || 0) + 1);
      const rows = [...bySite.entries()].sort((a, b) => b[1].matched - a[1].matched);
      const total = selectedMacs().size;

      $("review").innerHTML =
        `<div class="bc-note" style="margin-bottom:12px"><b>Org query: the client-by-client list is not shown.</b> ` +
        `With an org-wide query there can be more than 10,000 clients, so you cannot untick clients one at a time here. ` +
        `Download the CSV to check exactly which clients match, and paste any MACs to leave out below. ` +
        `To review and untick clients one by one, run a <b>single-site</b> query instead.</div>` +
        `<div class="bc-sum"><span class="bc-big">${total.toLocaleString()} clients will go on the ${esc(label)} list</span>` +
        `<span class="bc-muted">${m.length.toLocaleString()} match across ${rows.length} site(s) out of ${S.clients.length.toLocaleString()} live clients on the SSID</span>` +
        `<button class="bc-btn" data-bc="csvBtn">Download matched clients (CSV)</button></div>` +
        (S.failedSites.length ? `<div class="bc-note err" style="margin-bottom:10px">${S.failedSites.length} site(s) could not be read, so their clients are missing: ${esc(S.failedSites.slice(0, 10).join(", "))}${S.failedSites.length > 10 ? "…" : ""}</div>` : "") +
        `<div class="bc-scroll"><table><thead><tr><th>Site</th><th class="num">Live on SSID</th><th class="num">Matched</th><th class="num">Left out</th><th class="num">Selected</th></tr></thead><tbody>` +
        rows.map(([sid, r]) => `<tr><td>${esc(r.name)}</td><td class="num">${(liveBySite.get(sid) || 0).toLocaleString()}</td><td class="num">${r.matched.toLocaleString()}</td><td class="num">${r.excluded.toLocaleString()}</td><td class="num">${(r.matched - r.excluded).toLocaleString()}</td></tr>`).join("") +
        `</tbody></table></div>` +
        `<label class="bc-field wide" style="margin-top:12px"><span>MACs to leave out (one per line, any format)</span>` +
        `<textarea data-bc="orgExclude" placeholder="aa:bb:cc:dd:ee:ff">${esc([...S.orgExclude].map(ctx.fmtMac).join("\n"))}</textarea></label>` +
        `<button class="bc-btn" data-bc="applyExclude" style="margin-top:6px">Apply exclusions</button> <span class="bc-muted" data-bc="excludeMsg"></span>`;

      $("csvBtn").addEventListener("click", () => {
        const head = ["MAC", "Hostname", "Username", "IP", "Site", ...ATTRS.filter((a) => a.key !== "_site").map((a) => a.label), "Left out"];
        const body = m.map((c) => [
          ctx.fmtMac(c.mac), c.hostname, c.username, c.ip, c.siteName,
          ...ATTRS.filter((a) => a.key !== "_site").map((a) => c.attrs[a.key]),
          S.orgExclude.has(c.mac) ? "yes" : "",
        ]);
        const blob = new Blob([ctx.toCsv(head, body)], { type: "text/csv" });
        ctx.download(blob, ctx.stampedName(`mist_${S.list}_candidates`, `${ctx.orgName}_${S.query.ssid}`, "csv"));
      });

      $("applyExclude").addEventListener("click", () => {
        const { ok, bad } = parseMacs($("orgExclude").value);
        S.orgExclude = new Set(ok);
        S.plan = null;
        renderReview();
        renderPush();
        if (bad.length) $("excludeMsg").textContent = `Ignored (not a MAC): ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? "…" : ""}`;
      });
    }

    // ---- step 4: push ------------------------------------------------------

    function target() {
      if (S.query.scope === "site") return "site";
      if (S.list === "approved") return "sites";
      return $("target").value;
    }

    function renderPush() {
      if (!S.query) return;
      const L = LISTS[S.list];
      const f = S.query;
      $("pushTitle").textContent = `Push the ${L.label.toLowerCase()} list to Mist`;
      $("targetWrap").classList.toggle("bc-hidden", !(f.scope === "org" && S.list === "banned"));

      const t = target();
      $("extraHint").textContent =
        t === "site" ? `Pushing replaces ${f.siteName}'s ${L.label.toLowerCase()} list with the selected clients plus these MACs.`
        : t === "org" ? `Pushing replaces the org banned list with the selected clients plus these MACs.`
        : `Pushing replaces each site's ${L.label.toLowerCase()} list with that site's selected clients plus these MACs. Sites with no selected clients are left alone.` +
          (S.list === "approved" ? " (Mist has no org-level approved list.)" : "");

      const banned = S.list === "banned";
      $("enforceWrap").classList.toggle("bc-hidden", !banned);
      if (banned) {
        const off = S.wlans.filter((w) => !w.blocked).length;
        const on = S.wlans.length - off;
        $("enforceText").innerHTML = S.wlans.length
          ? `Turn on <i>Prevent banned clients from associating</i> for "${esc(f.ssid)}" where it is off ` +
            `<span class="bc-muted">(now on for ${on} WLAN${on === 1 ? "" : "s"}, off for ${off})</span>`
          : `<span class="bc-muted">No WLAN named "${esc(f.ssid)}" was found to check <i>Prevent banned clients from associating</i>.</span>`;
        $("enforce").disabled = !off;
      }
      renderPlan();
    }

    $("target").addEventListener("change", () => {
      S.plan = null;
      renderPush();
    });
    $("extra").addEventListener("input", () => {
      if (S.plan) {
        S.plan = null;
        renderPlan();
      }
    });
    $("enforce").addEventListener("change", () => {
      S.plan = null;
      renderPlan();
    });

    function buildPlan() {
      const L = LISTS[S.list];
      const f = S.query;
      const t = target();
      const { ok: extra, bad } = parseMacs($("extra").value);
      const bySite = selectedBySite();
      const calls = [];
      const warnings = [];
      const errors = [];

      if (bad.length) warnings.push(`Ignored in Extra MACs (not a MAC address): ${bad.slice(0, 8).join(", ")}${bad.length > 8 ? "…" : ""}`);

      if (t === "site" || t === "org") {
        const macs = new Set(extra);
        for (const set of bySite.values()) for (const m of set) macs.add(m);
        const list = [...macs];
        if (!list.length) errors.push("Nothing to push: no clients selected and no extra MACs.");
        if (t === "org" && list.length > ORG_BANNED_MAX) {
          errors.push(`The org banned list holds at most ${ORG_BANNED_MAX} MACs and this one has ${list.length}. Narrow the selection or push to each site's list.`);
        }
        const path = t === "site" ? `/sites/${f.siteId}/setting/${L.path}` : `/orgs/${ctx.orgId}/setting/${L.path}`;
        calls.push({
          kind: "list", method: "POST", path, body: { macs: list },
          what: `Replace ${t === "site" ? esc(f.siteName) + "'s" : "the org"} ${L.label.toLowerCase()} list with ${list.length.toLocaleString()} MAC(s)`,
          count: list.length,
        });
        if (S.list === "banned" && list.length > WLAN_ENFORCED_MAX) {
          warnings.push(`${list.length} MACs is more than the ${WLAN_ENFORCED_MAX} a WLAN enforces; only the first ${WLAN_ENFORCED_MAX} will be blocked.`);
        }
      } else {
        for (const [sid, set] of [...bySite.entries()].sort((a, b) => (site(a[0])?.name || "").localeCompare(site(b[0])?.name || ""))) {
          const list = [...new Set([...set, ...extra])];
          const name = site(sid)?.name || sid;
          calls.push({
            kind: "list", method: "POST", path: `/sites/${sid}/setting/${L.path}`, body: { macs: list },
            what: `Replace ${esc(name)}'s ${L.label.toLowerCase()} list with ${list.length.toLocaleString()} MAC(s)`,
            count: list.length,
          });
          if (S.list === "banned" && list.length > WLAN_ENFORCED_MAX) {
            warnings.push(`${name}: ${list.length} MACs, but a WLAN enforces only the first ${WLAN_ENFORCED_MAX}.`);
          }
        }
        if (!calls.length) errors.push("Nothing to push: no site has selected clients.");
        if (extra.length) warnings.push(`The ${extra.length} extra MAC(s) are added to every site in the list above.`);
      }

      if (S.list === "banned" && $("enforce").checked && !$("enforce").disabled) {
        for (const w of S.wlans.filter((x) => !x.blocked)) {
          const path = w.where === "org" ? `/orgs/${ctx.orgId}/wlans/${w.id}` : `/sites/${w.siteId}/wlans/${w.id}`;
          calls.push({
            kind: "wlan", method: "PUT", path, body: { block_blacklist_clients: true }, wlan: w,
            what: w.where === "org"
              ? `Turn on banned-client blocking for "${esc(w.ssid)}" in an org WLAN template (applies to every site using that template)`
              : `Turn on banned-client blocking for "${esc(w.ssid)}" at ${esc(w.siteName)}`,
          });
        }
      }

      if (f.cancelled) warnings.push("The client query was cancelled, so the selection may be missing clients.");
      if (S.failedSites.length) warnings.push(`${S.failedSites.length} site(s) could not be read; their clients are not included.`);

      return { calls, warnings, errors, list: S.list, target: t };
    }

    $("planBtn").addEventListener("click", () => {
      S.plan = buildPlan();
      renderPlan();
    });

    function renderPlan() {
      const p = S.plan;
      if (!p) {
        $("plan").innerHTML = "";
        return;
      }
      const canWrite = !ctx.access || ctx.access.canWrite !== false;
      const blocked = p.errors.length || !canWrite;
      const nList = p.calls.filter((c) => c.kind === "list").length;
      const where = p.target === "org" ? `org ${ctx.orgName}` : `${nList} site(s) in ${ctx.orgName}`;

      $("plan").innerHTML =
        (p.errors.length ? `<div class="bc-note err" style="margin-bottom:10px">${p.errors.map(esc).join("<br>")}</div>` : "") +
        (!canWrite ? `<div class="bc-note err" style="margin-bottom:10px">This token cannot make changes in ${esc(ctx.orgName)} (${esc(ctx.access.label || ctx.access.level)}). Mist would refuse these changes.</div>` : "") +
        (p.warnings.length ? `<div class="bc-note" style="margin-bottom:10px"><ul>${p.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : "") +
        `<div class="bc-scroll"><table><thead><tr><th>#</th><th>Change</th><th>Request</th></tr></thead><tbody>` +
        p.calls.map((c, i) => `<tr><td>${i + 1}</td><td>${c.what}</td><td class="bc-mono">${esc(c.method)} ${esc(c.path)}</td></tr>`).join("") +
        `</tbody></table></div>` +
        `<div class="bc-row" style="margin-top:12px">` +
        `<button class="bc-btn danger" data-bc="pushBtn"${blocked ? " disabled" : ""}>Push ${p.calls.length} change(s) to ${esc(where)}</button>` +
        `<button class="bc-btn" data-bc="macCsv">Download MAC list (CSV)</button>` +
        `<span class="bc-muted">Nothing is sent until you press Push.</span></div>` +
        `<div data-bc="result" style="margin-top:12px"></div>`;

      $("macCsv").addEventListener("click", () => {
        const rows = [];
        for (const c of p.calls) if (c.kind === "list") for (const m of c.body.macs) rows.push([c.path, ctx.fmtMac(m)]);
        const blob = new Blob([ctx.toCsv(["Mist list", "MAC"], rows)], { type: "text/csv" });
        ctx.download(blob, ctx.stampedName(`mist_${p.list}_list`, `${ctx.orgName}_${S.query.ssid}`, "csv"));
      });
      $("pushBtn").addEventListener("click", () => confirmPush(p));
    }

    function confirmPush(p) {
      const L = LISTS[p.list];
      const macTotal = p.calls.filter((c) => c.kind === "list").reduce((n, c) => n + c.count, 0);
      $("result").innerHTML =
        `<div class="bc-note err"><b>Confirm.</b> This replaces the ${esc(L.label.toLowerCase())} client list ` +
        `${p.target === "org" ? `for the org <b>${esc(ctx.orgName)}</b>` : `at ${p.calls.filter((c) => c.kind === "list").length} site(s) in <b>${esc(ctx.orgName)}</b>`} ` +
        `(${macTotal.toLocaleString()} MAC entries in total)` +
        (p.calls.some((c) => c.kind === "wlan") ? ` and turns on banned-client blocking on ${p.calls.filter((c) => c.kind === "wlan").length} WLAN(s)` : "") +
        `. Any MAC now on the list that is not in this push will be removed from it.` +
        (ctx.access ? `<br>Token: ${esc(ctx.access.label || ctx.access.level)}` : "") +
        `<div class="bc-row" style="margin-top:8px"><button class="bc-btn danger" data-bc="yesBtn">Yes, push now</button><button class="bc-btn" data-bc="noBtn">Cancel</button></div></div>`;
      $("noBtn").addEventListener("click", () => ($("result").innerHTML = ""));
      $("yesBtn").addEventListener("click", () => applyPlan(p));
    }

    async function applyPlan(p) {
      if (S.busy) return;
      S.busy = true;
      $("pushBtn").disabled = true;
      $("planBtn").disabled = true;
      $("getBtn").disabled = true;
      const results = [];
      try {
        for (let i = 0; i < p.calls.length; i++) {
          const c = p.calls[i];
          setStatus(`Pushing ${i + 1} of ${p.calls.length}…`);
          setProgress(i, p.calls.length);
          try {
            await ctx.mistWrite(c.method, c.path, c.body);
            results.push({ c, ok: true, msg: "Done" });
            ctx.log(`${c.method} ${c.path}${c.count != null ? ` (${c.count} MACs)` : ""}: done`, "ok");
            if (c.kind === "wlan") c.wlan.blocked = true;
          } catch (err) {
            results.push({ c, ok: false, msg: err.message });
            ctx.log(`${c.method} ${c.path}: ${err.message}`, "err");
          }
        }
      } finally {
        S.busy = false;
        $("planBtn").disabled = false;
        $("getBtn").disabled = false;
        setProgress(0, 0);
      }
      const bad = results.filter((r) => !r.ok).length;
      setStatus(bad ? `${bad} of ${results.length} change(s) failed` : `All ${results.length} change(s) pushed`);
      $("result").innerHTML =
        `<div class="bc-note ${bad ? "err" : "ok"}" style="margin-bottom:8px">${bad ? `${bad} of ${results.length} change(s) failed. The others were applied.` : `All ${results.length} change(s) were applied in Mist.`}</div>` +
        `<div class="bc-scroll"><table><thead><tr><th>Change</th><th>Result</th></tr></thead><tbody>` +
        results.map((r) => `<tr><td>${r.c.what}</td><td>${r.ok ? "Done" : esc(r.msg)}</td></tr>`).join("") +
        `</tbody></table></div>`;
    }

    // ---- current lists in Mist ---------------------------------------------

    // Mist has no GET for the lists themselves. Org and site settings carry a
    // read-only blacklist_url / whitelist_url pointing at the list file, which
    // can be read when it is served from the Mist API host.
    async function readListFile(url) {
      let u;
      try {
        u = new URL(url);
      } catch {
        return { error: "Mist gave a list link that is not a valid URL." };
      }
      if (u.host !== ctx.host || !u.pathname.startsWith("/api/v1/")) {
        return { error: `The list file is on ${u.host}, which this tool cannot read. Open it from the link.` };
      }
      try {
        const data = await ctx.mistGet(u.pathname.slice("/api/v1".length), Object.fromEntries(u.searchParams));
        const raw = Array.isArray(data) ? data
          : data && Array.isArray(data.macs) ? data.macs
          : typeof data === "string" ? data.split(/\s+/)
          : null;
        if (!raw) return { error: "The list file is not in a format this tool understands. Open it from the link." };
        return { macs: parseMacs(raw.map((x) => (typeof x === "string" ? x : (x && x.mac) || "")).join("\n")).ok };
      } catch (err) {
        return { error: `Could not read the list file: ${err.message}` };
      }
    }

    S.current = null;

    $("checkBtn").addEventListener("click", checkLists);

    async function checkLists() {
      if (S.busy) return;
      const sid = $("site").value;
      if (S.scope === "site" && !sid) return ($("checkStatus").textContent = "Choose a site in step 1 first.");
      S.busy = true;
      $("checkBtn").disabled = true;
      $("current").innerHTML = "";
      $("checkCsv").classList.add("bc-hidden");
      const lists = [];
      const noList = [];
      try {
        $("checkStatus").textContent = "Reading org settings…";
        const orgSet = await ctx.mistGet(`/orgs/${ctx.orgId}/setting`);
        if (orgSet && orgSet.blacklist_url) lists.push({ kind: "banned", where: "org", name: ctx.orgName, url: orgSet.blacklist_url });

        const sites = S.scope === "site" ? [site(sid)] : S.sites;
        let done = 0;
        await ctx.pool(ctx.POOL_LIMIT, sites.map((s) => async () => {
          try {
            const set = await ctx.mistGet(`/sites/${s.id}/setting`);
            if (set && set.blacklist_url) lists.push({ kind: "banned", where: "site", siteId: s.id, name: s.name, url: set.blacklist_url });
            if (set && set.whitelist_url) lists.push({ kind: "approved", where: "site", siteId: s.id, name: s.name, url: set.whitelist_url });
            if (!set || (!set.blacklist_url && !set.whitelist_url)) noList.push(s.name);
          } catch (err) {
            lists.push({ kind: "banned", where: "site", siteId: s.id, name: s.name, error: `Could not read site settings: ${err.message}` });
          } finally {
            done += 1;
            $("checkStatus").textContent = `Reading site settings: ${done} of ${sites.length}`;
          }
        }));

        const files = lists.filter((l) => l.url);
        done = 0;
        await ctx.pool(ctx.POOL_LIMIT, files.map((l) => async () => {
          Object.assign(l, await readListFile(l.url));
          done += 1;
          $("checkStatus").textContent = `Reading lists: ${done} of ${files.length}`;
        }));

        lists.sort((a, b) =>
          (a.where === "org" ? 0 : 1) - (b.where === "org" ? 0 : 1) ||
          a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
        S.current = { lists, noList, scope: S.scope };
        const macs = lists.reduce((n, l) => n + (l.macs ? l.macs.length : 0), 0);
        $("checkStatus").textContent = `${lists.length} list(s) found · ${macs.toLocaleString()} MAC entries`;
        ctx.log(`Checked current lists: ${lists.length} list(s), ${macs} MAC entries`, "ok");
        renderCurrent();
      } catch (err) {
        $("checkStatus").textContent = `Failed: ${err.message}`;
        ctx.log(err.message, "err");
      } finally {
        S.busy = false;
        $("checkBtn").disabled = false;
      }
    }

    let byMac = { from: null, map: new Map() };
    function knownClient(mac) {
      if (byMac.from !== S.clients) byMac = { from: S.clients, map: new Map(S.clients.map((c) => [c.mac, c])) };
      return byMac.map.get(mac);
    }

    function renderCurrent() {
      const { lists, noList, scope } = S.current;
      const ssid = S.query ? S.query.ssid : "";
      const open = lists.length <= 4;
      const html = lists.map((l, i) => {
        const tag = `<span class="bc-tag ${l.kind}">${LISTS[l.kind].label}</span>`;
        const title = l.where === "org" ? `Org: ${esc(l.name)}` : esc(l.name);
        if (!l.macs) {
          return `<details class="bc-list" open><summary>${tag}<b>${title}</b></summary><div class="bc-body">` +
            `<div class="bc-note err">${esc(l.error || "Could not read this list.")}` +
            (l.url ? ` <a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">Open the list file</a>` : "") +
            `</div></div></details>`;
        }
        // "Keep" adds to Extra MACs, which only makes sense when the push goes to this same list.
        const canKeep = l.where === "org" || scope === "site";
        const rows = l.macs.map((m) => {
          const c = knownClient(m);
          return `<tr><td class="bc-mono">${esc(ctx.fmtMac(m))}</td>` +
            `<td>${esc(c ? c.hostname : "")}</td><td>${esc(c ? cell(c.attrs.family) : "")}</td>` +
            `<td>${esc(c ? cell(c.attrs.manufacture) : "")}</td><td>${esc(c ? cell(c.attrs.os) : "")}</td>` +
            `<td>${c ? `Yes, at ${esc(c.siteName)}` : ""}</td></tr>`;
        }).join("");
        return `<details class="bc-list"${open ? " open" : ""}><summary>${tag}<b>${title}</b>` +
          `<span class="bc-muted">${l.macs.length.toLocaleString()} MAC(s)` +
          (l.kind === "banned" && l.macs.length > WLAN_ENFORCED_MAX ? ` · only the first ${WLAN_ENFORCED_MAX} are enforced` : "") + `</span>` +
          (canKeep && l.macs.length ? `<button class="bc-btn" data-keep="${i}" style="margin-left:auto">Keep these: add to Extra MACs</button>` : "") +
          `</summary><div class="bc-body">` +
          (l.macs.length
            ? `<div class="bc-tbl" style="max-height:320px"><table><thead><tr><th>MAC</th><th>Hostname</th><th>Family</th><th>Manufacturer</th><th>OS</th><th>Live on ${esc(ssid || "SSID")}</th></tr></thead><tbody>${rows}</tbody></table></div>`
            : `<p class="bc-muted">The list is empty.</p>`) +
          `</div></details>`;
      }).join("");

      $("current").innerHTML =
        (html || `<p class="bc-muted">No banned or approved lists are set ${scope === "site" ? "for this site or the org" : "in this org"}.</p>`) +
        (lists.length && noList.length ? `<p class="bc-muted">${noList.length} site(s) have no site-level list.</p>` : "") +
        `<p class="bc-muted" data-bc="keepMsg"></p>`;
      $("checkCsv").classList.toggle("bc-hidden", !lists.some((l) => l.macs && l.macs.length));

      for (const btn of $("current").querySelectorAll("[data-keep]")) {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          const l = lists[Number(btn.dataset.keep)];
          const have = parseMacs($("extra").value).ok;
          const add = l.macs.filter((m) => !have.includes(m));
          $("extra").value = [...have, ...add].map(ctx.fmtMac).join("\n");
          S.plan = null;
          if (S.query) renderPlan();
          $("keepMsg").textContent =
            `Added ${add.length} MAC(s) from the ${LISTS[l.kind].label.toLowerCase()} list for ${l.name} to Extra MACs in step 4` +
            (S.list !== l.kind ? ` (note: step 1 is set to build the ${LISTS[S.list].label.toLowerCase()} list)` : "") + ".";
        });
      }
    }

    $("checkCsv").addEventListener("click", () => {
      const rows = [];
      for (const l of S.current.lists) {
        for (const m of l.macs || []) {
          const c = knownClient(m);
          rows.push([LISTS[l.kind].label, l.where === "org" ? "Org" : "Site", l.name, ctx.fmtMac(m),
            c ? c.hostname : "", c ? cell(c.attrs.family) : "", c ? cell(c.attrs.manufacture) : "", c ? cell(c.attrs.os) : ""]);
        }
      }
      const blob = new Blob([ctx.toCsv(["List", "Level", "Org / site", "MAC", "Hostname", "Family", "Manufacturer", "OS"], rows)], { type: "text/csv" });
      ctx.download(blob, ctx.stampedName("mist_current_client_lists", ctx.orgName, "csv"));
    });

    function renderAll() {
      const has = !!S.query;
      $("attrCard").classList.toggle("bc-hidden", !has || !S.clients.length);
      $("reviewCard").classList.toggle("bc-hidden", !has);
      $("pushCard").classList.toggle("bc-hidden", !has || !S.clients.length);
      renderAttrs();
      renderReview();
      renderPush();
    }

    await init();
  },
};
