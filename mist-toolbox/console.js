// Dashboard controller. Ported verbatim from mist_disconnect_console.py PAGE
// lines 3428-4048; the only changes are the ones the extension forces:
//   * the api() POST shim is gone — the four call sites now call the engine and
//     the Mist fetch layer directly, so no request ever leaves this page except
//     the HTTPS GETs to the nine allowlisted Mist regions;
//   * the connect form is a <div> (see console.html) so no password-manager
//     save prompt can persist the token;
//   * an idle wipe clears state.token and returns to the connect view.
//
// state.token is the token's entire lifetime: set from the input, passed as a
// function argument, never stored, never messaged to the service worker,
// never logged.

import { demoResult } from "./engine/demo.js";
import { MIST_HOSTS } from "./engine/util.js";
import { diagnoseClient, listSites, mistConnect } from "./mist.js";

// Wipe the in-memory token after this long without user interaction, and after
// this long with the tab hidden. Closing or reloading the tab already loses it.
const IDLE_WIPE_MS = 30 * 60 * 1000;

// Region list now comes from engine/util.js so the console and the toolbox
// cannot drift apart; it grew from 9 to 13 when the Python scripts' own region
// tables were consolidated.
const HOSTS = MIST_HOSTS;
const $ = (id) => document.getElementById(id);
const hostSel = $("host");
HOSTS.forEach(h => { const o=document.createElement("option"); o.value=h; o.textContent=h+(h==="api.gc2.mist.com"?" (default)":""); hostSel.appendChild(o); });
const state = { token:"", host:"api.gc2.mist.com", orgs:[], orgId:"", sites:[], siteId:"", mac:"", duration:"1d", result:null, live:false, liveSec:15, timer:null, samples:[], busy:false, demo:false, email:"", occFilter:"all", radioFs:false };

function show(id) {
  ["viewConnect","viewScope","viewBoard"].forEach(v => $(v).classList.toggle("hidden", v!==id));
  $("btnSession").classList.toggle("hidden", id==="viewConnect");
}
function setErr(msg) { const e=$("err"); e.textContent=msg||""; e.classList.toggle("hidden", !msg); }
function setSub() { $("sub").textContent = "direct · "+state.host+(state.email?" · "+state.email:""); }

function fmtMac(m){ const n=(m||"").replace(/[^0-9a-f]/gi,"").toLowerCase(); return n.length===12?n.match(/.{2}/g).join(":"):m; }
function fmtTime(ts){ if(ts==null||ts==="") return "—"; const n=Number(ts); const ms=n>1e11?n:n*1000; try{ return new Date(ms).toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit"});}catch(e){return String(ts);} }
function fmtDur(sec){ if(sec==null) return "—"; if(sec<60) return Math.round(sec)+"s"; if(sec<3600) return Math.floor(sec/60)+"m "+Math.round(sec%60)+"s"; return Math.floor(sec/3600)+"h "+Math.floor((sec%3600)/60)+"m"; }
function fmtBytes(n){ if(n==null) return "—"; if(n<1024) return n+" B"; if(n<1048576) return (n/1024).toFixed(1)+" KB"; return (n/1048576).toFixed(1)+" MB"; }
function rssiBand(v){ if(v==null) return "unknown"; if(v<-75) return "crit"; if(v<-65) return "warn"; return "good"; }
function snrBand(v){ if(v==null) return "unknown"; if(v<15) return "crit"; if(v<25) return "warn"; return "good"; }
function bandClass(b){ return b==="crit"?"crit":b==="warn"?"warn":b==="good"?"good":"muted"; }
function esc(s){
  return String(s == null ? "" : s)
    .replace(/&/g, "&"+"amp;")
    .replace(/</g, "&"+"lt;")
    .replace(/>/g, "&"+"gt;")
    .replace(/"/g, "&"+"quot;")
    .replace(/'/g, "&#39;");
}
function reason(code){ const map={1:"Unspecified",2:"Previous authentication no longer valid",3:"STA leaving IBSS/ESS",4:"Disassociated due to inactivity",5:"AP cannot handle all currently associated STAs",6:"Class 2 frame from nonauthenticated STA",7:"Class 3 frame from nonassociated STA",8:"STA leaving BSS",9:"STA requesting (re)association is not authenticated",10:"Unacceptable power capability",13:"Invalid information element",14:"MIC failure",15:"4-way handshake timeout",16:"Group key handshake timeout",17:"IE in 4-way handshake different from (re)assoc",18:"Invalid group cipher",19:"Invalid pairwise cipher",20:"Invalid AKMP",23:"IEEE 802.1X authentication failed",39:"The QoS AP lacks sufficient bandwidth"}; if(code==null||code==="") return ""; const n=Number(code); return map[n]?n+" — "+map[n]:String(code); }

async function connect(){
  setErr(""); state.busy=true; $("btnConnect").disabled=true;
  try {
    const typed=$("token").value.trim();
    if(typed.length<8) throw new Error("Paste a read-only Observer API token.");
    state.token=typed; state.host=$("host").value;
    const res = await mistConnect(state.token, state.host);
    state.email=res.email; state.orgs=res.orgs; state.orgId=res.orgs[0]?.id||"";
    // Clear the field once the token is in memory — nothing else should hold it.
    $("token").value="";
    fillSelect($("org"), state.orgs); setSub();
    await loadSites(); show("viewScope");
  } catch(err) { setErr(err.message); } finally { state.busy=false; $("btnConnect").disabled=false; }
}
$("btnConnect").onclick = connect;
$("token").addEventListener("keydown", (e)=>{ if(e.key==="Enter"){ e.preventDefault(); connect(); } });
$("btnDemo").onclick = async () => {
  setErr(""); const res = demoResult(false);
  state.demo=true; state.result=res; state.mac=fmtMac(res.mac); state.email=res.email||"demo@local";
  state.host=res.host; $("host").value=res.host; setSub(); state.samples=[]; setLive(false); renderBoard(); show("viewBoard");
};
$("org").onchange = () => { state.orgId=$("org").value; loadSites(); };
async function loadSites(){
  const listed = await listSites(state.token, state.host, state.orgId);
  state.sites=listed; state.siteId=listed[0]?.id||""; fillSelect($("site"), listed);
}
function fillSelect(el, items){ el.innerHTML=""; items.forEach(it=>{ const o=document.createElement("option"); o.value=it.id; o.textContent=it.name; el.appendChild(o); }); if(items[0]) el.value=items[0].id; }
$("formScope").onsubmit = async (e) => { e.preventDefault(); state.mac=$("mac").value; state.duration=$("duration").value; state.siteId=$("site").value; state.orgId=$("org").value; await runDiag(false); };
$("btnSession").onclick = () => wipeToken("");

async function runDiag(fromLive){
  if(state.busy && fromLive) return;
  state.busy=true;
  try {
    let res;
    if(state.demo) res = demoResult(!!fromLive);
    else res = await diagnoseClient({token:state.token, host:state.host, orgId:state.orgId, siteId:state.siteId, siteName:(state.sites.find(s=>s.id===state.siteId)||{}).name||"", mac:state.mac||state.result?.mac, duration:state.duration, live:!!fromLive});
    if(state.live && !document.hidden) touchIdle();
    state.result=res;
    state.samples = [...state.samples.slice(-47), {t:res.fetchedAt, rssi:res.stats?.rssi??null, snr:res.stats?.snr??null}];
    renderBoard(); show("viewBoard");
  } catch(err) {
    setErr(err.message);
    if(/429|rate limit/i.test(err.message)) setLive(false);
  } finally { state.busy=false; }
}
function setLive(on){
  state.live=on;
  if(state.timer){ clearInterval(state.timer); state.timer=null; }
  if(on){ state.timer=setInterval(()=>{ if(document.hidden) return; runDiag(true); }, state.liveSec*1000); }
}
document.addEventListener("keydown", (e)=>{
  if(e.key!=="Escape" || !state.radioFs) return;
  state.radioFs=false;
  document.body.classList.remove("radio-fs-open");
  if(state.result) renderBoard();
});

function spark(samples, field){
  const pts=samples.map(s=>s[field]).filter(v=>v!=null);
  if(pts.length<2) return `<p class="subtle" style="font-size:12px">Need two live samples to plot ${field.toUpperCase()}.</p>`;
  const w=280,h=56,min=Math.min(...pts),max=Math.max(...pts),span=max-min||1;
  const d=pts.map((v,i)=>{ const x=(i/(pts.length-1))*(w-8)+4; const y=h-6-((v-min)/span)*(h-12); return `${i?"L":"M"}${x.toFixed(1)},${y.toFixed(1)}`; }).join(" ");
  return `<svg viewBox="0 0 ${w} ${h}" class="break" style="height:56px;width:100%"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent)"/></svg>`;
}

function occBand(ch, band){
  if(band==="24") return "24";
  if(band==="6") return "6";
  if(ch>=36 && ch<=48) return "unii1";
  if(ch>=52 && ch<=64) return "unii2";
  if(ch>=100 && ch<=144) return "unii2e";
  if(ch>=149 && ch<=165) return "unii3";
  return "other";
}

function occChart(ap){
  const all = (ap && ap.channels) || [];
  const filt = state.occFilter || "all";
  const servingCh = (all.find(c=>c.serving)||{}).channel;
  let chs;
  if(filt==="all"){
    if(servingCh>=100 && servingCh<=165)
      chs = all.filter(c => occBand(c.channel, ap.band)==="unii2e" || occBand(c.channel, ap.band)==="unii3");
    else if(servingCh>=36 && servingCh<=64)
      chs = all.filter(c => occBand(c.channel, ap.band)==="unii1" || occBand(c.channel, ap.band)==="unii2");
    else
      chs = all;
  } else {
    chs = all.filter(c => occBand(c.channel, ap.band)===filt);
  }
  if(!all.length){
    const r = ap && ap.radio;
    if(!r) return `<p class="muted">No occupancy histogram for this AP (RRM considerations empty). Serving-channel util still shown above when radio_stat is present.</p>`;
    return "";
  }
  if(!chs.length) return `<p class="muted">No channels in this UNII / band filter. Switch to All.</p>`;
  const w = Math.max(620, chs.length*42);
  const h = 228, padL=52, padB=36, padT=14, padR=10;
  const innerW = w-padL-padR, innerH = h-padT-padB;
  const bw = innerW/chs.length;
  const yticks = [0,25,50,75,100].map(p=>{
    const y = padT+innerH-(p/100)*innerH;
    return `<line x1="${padL}" x2="${w-padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--border)"/>
      <text x="${padL-6}" y="${(y+4).toFixed(1)}" text-anchor="end" fill="var(--subtle)" font-size="10">${p}%</text>`;
  }).join("");
  const bars = chs.map((c,i)=>{
    const x = padL + i*bw + bw*0.2;
    const barW = bw*0.6;
    const y0 = padT+innerH;
    const hN = (Math.min(100,c.nonWifi||0)/100)*innerH;
    const hS = (Math.min(100,c.site||0)/100)*innerH;
    const hE = (Math.min(100,c.external||0)/100)*innerH;
    const tot = (c.nonWifi||0)+(c.site||0)+(c.external||0);
    const flash = (c.nonWifi||0)>=30 ? " pulse-c" : tot>=70 ? " pulse-w" : "";
    const labelFill = c.serving ? "var(--fg)" : "var(--subtle)";
    return `<g class="${flash.trim()}">
      <rect x="${x.toFixed(1)}" y="${(y0-hN).toFixed(1)}" width="${barW.toFixed(1)}" height="${hN.toFixed(1)}" fill="var(--occ-nonwifi)" rx="1"/>
      <rect x="${x.toFixed(1)}" y="${(y0-hN-hS).toFixed(1)}" width="${barW.toFixed(1)}" height="${hS.toFixed(1)}" fill="var(--occ-site)" rx="1"/>
      <rect x="${x.toFixed(1)}" y="${(y0-hN-hS-hE).toFixed(1)}" width="${barW.toFixed(1)}" height="${hE.toFixed(1)}" fill="var(--occ-ext)" rx="1"/>
      <text x="${(x+barW/2).toFixed(1)}" y="${h-10}" text-anchor="middle" fill="${labelFill}" font-size="${c.serving?12:11}" font-weight="${c.serving?700:500}">${esc(c.channel)}</text>
    </g>`;
  }).join("");
  const ylab = `<text transform="translate(12,${padT+innerH/2}) rotate(-90)" text-anchor="middle" fill="var(--muted)" font-size="11">Channel Occupancy</text>`;
  return `<div class="occ-scroll"><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Channel occupancy" style="width:100%;min-width:560px;height:220px">${ylab}${yticks}${bars}</svg></div>`;
}

function occPanel(ap){
  if(!ap) return `<div class="card"><h2 class="subtle" style="margin:0;font-size:13px;text-transform:uppercase">Current radio values</h2><p class="muted">No serving AP identified from sessions.</p></div>`;
  if(ap.unavailable && !ap.radio && !(ap.channels||[]).length){
    return `<div class="card"><h2 class="subtle" style="margin:0;font-size:13px;text-transform:uppercase">Current radio values</h2><p class="muted">${esc(ap.unavailable)}</p></div>`;
  }
  const r = ap.radio||{};
  const servingBar = (ap.channels||[]).find(c=>c.serving) || {};
  const nw = servingBar.nonWifi!=null ? servingBar.nonWifi : (r.utilNonWifi||0);
  const ext = servingBar.external!=null ? servingBar.external : ((r.utilRxOtherBss||0)+(r.utilUnknownWifi||0));
  const site = servingBar.site!=null ? servingBar.site : (r.utilRxInBss||0);
  const tot = Math.min(100, nw+ext+site);
  const src = ap.source==="marvis" ? "most of the time (Marvis)"
    : ap.source==="sessions" ? `most session time (${fmtDur(ap.dwellSeconds)})`
    : "from "+(ap.source||"stats");
  const marvisNote = (ap.marvisAps||[]).length && !(ap.marvisMentioned)
    ? ` Marvis also named AP ${fmtMac(ap.marvisAps[0])} — dwell wins.`
    : (ap.marvisMentioned ? " Marvis named this AP as well." : "");
  const scopeNote = ap.scope==="site" ? " Histogram is site-wide channel scores (per-AP RRM empty)." : " Histogram is this AP's 20-min RRM scan — same wifi / non_wifi occupancy as Site → Radio Management → Current Radio Values. Site vs External splits wifi occupancy by same-site vs other-site RSSI. Live radio_stat utilization is the AP table only, not these bars.";
  const servingFlash = nw>=30?" pulse-c": tot>=70?" pulse-w":"";
  const bands = new Set((ap.channels||[]).map(c=>occBand(c.channel, ap.band)));
  const filters = [
    ["all","All"],
    ["unii1","UNII-1"],
    ["unii2","UNII-2"],
    ["unii2e","UNII-2 Ext"],
    ["unii3","UNII-3"],
    ["24","2.4 GHz"],
    ["6","6 GHz"],
  ].filter(([id]) => id==="all" || bands.has(id));
  if(state.occFilter!=="all" && !bands.has(state.occFilter)) state.occFilter="all";
  const chips = filters.map(([id,lab]) =>
    `<button class="chip${state.occFilter===id?" on":""}" type="button" data-occ="${id}">${lab}</button>`
  ).join("");
  return `<div class="card">
    <div class="row" style="align-items:flex-start;flex-wrap:wrap">
      <div>
        <h2 class="subtle" style="margin:0;font-size:13px;text-transform:uppercase">Current radio values</h2>
        <p class="muted" style="margin:.35rem 0 0;font-size:13px">RF as seen by the AP this client spent ${esc(src)} on.${esc(marvisNote)}</p>
        ${ap.selectionNote?`<p class="${ap.fallback?"warn":"muted"}" style="margin:.4rem 0 0;font-size:13px">${esc(ap.selectionNote)}</p>`:""}
      </div>
      <span class="pill ${ap.status==="connected"?"good":"muted"}">${esc(ap.status||"ap")}</span>
    </div>
    <div class="row" style="flex-wrap:wrap;margin-top:.7rem">
      <div class="legend" style="margin:0">
        <span><i class="swatch" style="background:var(--occ-ext)"></i>External APs</span>
        <span><i class="swatch" style="background:var(--occ-site)"></i>Site APs</span>
        <span><i class="swatch" style="background:var(--occ-nonwifi)"></i>Non-Wi-Fi</span>
      </div>
      <div class="chiprow" id="occFilters">${chips}</div>
    </div>
    ${occChart(ap)}
    <p class="subtle" style="font-size:11px;margin:.35rem 0 0">Channel occupancy % · serving channel in bold.${esc(scopeNote)} Bars flash when Non-Wi-Fi ≥ 30% or total ≥ 70%.</p>
    <div class="metrics" style="margin-top:1rem;grid-template-columns:repeat(3,minmax(0,1fr))">
      <div class="card metric${nw>=30?" pulse-c":""}" style="min-height:72px">
        <div class="subtle" style="font-size:11px;text-transform:uppercase">Non-Wi-Fi</div>
        <div class="mono ${nw>=30?"crit":nw>=15?"warn":"good"}" style="font-size:1.25rem">${esc(nw)}%</div>
      </div>
      <div class="card metric${ext>=30?" pulse-w":""}" style="min-height:72px">
        <div class="subtle" style="font-size:11px;text-transform:uppercase">External APs</div>
        <div class="mono ${ext>=30?"warn":"muted"}" style="font-size:1.25rem">${esc(ext)}%</div>
      </div>
      <div class="card metric" style="min-height:72px">
        <div class="subtle" style="font-size:11px;text-transform:uppercase">Site / in-BSS</div>
        <div class="mono" style="font-size:1.25rem">${esc(site)}%</div>
      </div>
    </div>
    <div style="overflow-x:auto;margin-top:1rem">
      <table class="ap-table">
        <thead><tr>
          <th>AP</th><th>MAC</th><th>Band</th><th>Clients</th><th>Channel</th><th>Width</th><th>Power</th><th>Util</th>
        </tr></thead>
        <tbody><tr>
          <td>${esc(ap.apName||"—")}</td>
          <td class="mono">${esc(fmtMac(ap.apMac||""))}</td>
          <td>${esc(ap.band==="24"?"2.4 GHz":ap.band==="6"?"6 GHz":"5 GHz")}</td>
          <td class="mono">${esc(r.numClients??"—")}</td>
          <td class="mono" style="font-weight:700">${esc(r.channel??"—")}</td>
          <td class="mono">${r.bandwidth!=null?esc(r.bandwidth)+" MHz":"—"}</td>
          <td class="mono">${r.power!=null?esc(r.power)+" dBm":"—"}</td>
          <td class="mono${servingFlash}">${r.utilAll!=null?esc(r.utilAll)+"%":"—"}</td>
        </tr></tbody>
      </table>
    </div>
  </div>`;
}

function metric(label,value,hint,band){
  const pulse=band==="crit"?" pulse-c":band==="warn"?" pulse-w":"";
  return `<div class="card metric${pulse}"><div class="subtle" style="font-size:12px;text-transform:uppercase">${esc(label)}</div>
    <div class="mono ${bandClass(band)}" style="font-size:1.4rem;margin-top:.4rem">${esc(value)}</div>
    <div class="muted" style="font-size:12px">${esc(hint||"")}</div></div>`;
}

function radioEventKind(ev){
  const t=(ev.event||"").toLowerCase();
  if(t.includes("radar")) return "crit";
  if(ev.channelChanged || t.includes("interference")) return "warn";
  return "muted";
}
function bandHz(b){
  const s=String(b||"");
  if(s==="24"||s==="2.4") return "2.4 GHz";
  if(s==="6") return "6 GHz";
  if(!s) return "—";
  return "5 GHz";
}
function arrow(a,b,unit){
  if(a==null && b==null) return "—";
  if(a==null || a==="" || a===0 || String(a)===String(b)) return (b==null?"—":esc(b)+(unit||""));
  return esc(a)+(unit||"")+" → "+esc(b)+(unit||"");
}
function clientRadarPanel(r){
  const rows = r.clientRadarEvents||[];
  const alerts = r.radarAlerts||[];
  const st = r.radioStoreStats||{};
  const statsBit = st.scanned!=null
    ? ` Scanned ${st.scanned} site radio events · indexed ${st.radars||0} DFS/Post radar · ${rows.length} overlapped this MAC's session on the same AP.`
    : "";
  // The session-on-radar banner already lists these same DFS rows. Do not paint them twice.
  if(alerts.length) return "";
  if(!rows.length){
    return `<div class="card">
      <h2 class="subtle" style="margin:0 0 .35rem;font-size:13px;text-transform:uppercase">Radar hits on this client's APs (0)</h2>
      <p class="muted" style="margin:0;font-size:12px">No DFS / Post radar overlapped a session on the same AP in this lookback.${esc(statsBit)} Neighbor-AP radar is indexed in the radar store but is not this client's problem — it does not deauth this MAC.</p>
    </div>`;
  }
  return `<div class="card pulse-c" style="border-color:color-mix(in oklab, var(--crit) 70%, var(--border))">
    <h2 class="subtle" style="margin:0 0 .35rem;font-size:13px;text-transform:uppercase">Radar hits on this client's APs (${rows.length})</h2>
    <p class="muted" style="margin:0 0 .7rem;font-size:12px">Dedicated radar store — every DFS / Post radar on an AP this MAC was associated to in the lookback. Not truncated by the site-wide table. Same-AP + session overlap required.${esc(statsBit)}</p>
    <div class="sess-scroll occ-scroll">
    <table class="ap-table">
      <thead><tr><th>Date</th><th>AP</th><th>Band</th><th>Channel</th><th>Width</th><th>Power</th><th>Event</th></tr></thead>
      <tbody>${rows.map(radioRow).join("")}</tbody>
    </table>
    </div>
  </div>`;
}
function radioEventsPanel(r){
  if(r.radioEventsUnavailable && !(r.radioEvents||[]).length){
    return `<div class="card"><h2 class="subtle" style="margin:0;font-size:13px;text-transform:uppercase">Radio events</h2>
      <p class="muted">Radio Management events not available (${esc(r.radioEventsUnavailable)}). This console queries GET /sites/{id}/rrm/events?band=5|24|6 with start/end matching the lookback (band is required by Mist).</p></div>`;
  }
  const rows = r.radioEvents||[];
  if(!rows.length){
    return `<div class="card"><h2 class="subtle" style="margin:0;font-size:13px;text-transform:uppercase">Radio events</h2>
      <p class="muted">No Radio Management events in this lookback (scheduled RRM, Post radar, interference, neighbor AP). Client disconnects in this window are not radio-event driven.</p></div>`;
  }
  const ranked = rows.slice().sort((a,b)=>{
    const ha = a.highlight?1:0, hb = b.highlight?1:0;
    if(hb!==ha) return hb-ha;
    const oa = a.onClientAp?1:0, ob = b.onClientAp?1:0;
    if(ob!==oa) return ob-oa;
    return (Number(b.timestamp)||0)-(Number(a.timestamp)||0);
  });
  const hitN = rows.filter(e=>e.highlight).length;
  const fs = !!state.radioFs;
  const head = `<div class="row radio-fs-head">
      <h2 class="subtle" id="radioEventsTitle" style="margin:0;font-size:13px;text-transform:uppercase">Radio events (${ranked.length})</h2>
      <button class="btn btn-s" type="button" id="btnRadioFs" aria-pressed="${fs?"true":"false"}">${fs?"Exit full screen":"Full screen"}</button>
    </div>`;
  const body = `<p class="muted" style="margin:0 0 .7rem;font-size:12px">Same source as Mist <span style="color:var(--fg)">Site → Radio Management → Radio Events</span> for this lookback. <strong style="color:var(--crit)">Post radar on the AP this client was connected to</strong> is highlighted (${hitN}). Scroll the box — the full kept list is here (site-wide noise is filtered to a sample; client-AP radar is never dropped).${fs?" Esc exits full screen.":""}</p>
    <div class="sess-scroll occ-scroll" id="radioEventsScroll">
    <table class="ap-table">
      <thead><tr>
        <th>Date</th><th>AP</th><th>Band</th><th>Channel</th><th>Width</th><th>Power</th><th>Event</th>
      </tr></thead>
      <tbody>
      ${ranked.map(ev=>{
        const hit = !!ev.highlight;
        const on = !!ev.onClientAp;
        const name = ev.apName || fmtMac(ev.ap||"");
        const cls = hit?"crit":(String(ev.event||"").includes("radar")?"warn":"");
        return `<tr class="${hit?"pulse-c":""}" style="${hit?"background:color-mix(in oklab, var(--crit) 12%, transparent)":on?"background:color-mix(in oklab, var(--accent) 8%, transparent)":""}">
          <td class="mono subtle">${esc(fmtTime(ev.timestamp))}</td>
          <td class="mono break">${esc(name)}${hit?' <span class="pill crit">on this client</span>':on?' <span class="pill">client AP</span>':""}</td>
          <td class="mono">${esc(bandHz(ev.preUsage||ev.band))} → ${esc(bandHz(ev.usage||ev.band))}</td>
          <td class="mono">${arrow(ev.preChannel, ev.channel, "")}</td>
          <td class="mono">${arrow(ev.preBandwidth, ev.bandwidth, " MHz")}</td>
          <td class="mono">${arrow(ev.prePower, ev.power, " dBm")}</td>
          <td class="mono ${cls}">${esc(ev.label||ev.event||"—")}</td>
        </tr>`;
      }).join("")}
      </tbody>
    </table>
    </div>`;
  if(fs){
    return `<div class="radio-fs" id="radioEventsCard" role="dialog" aria-modal="true" aria-labelledby="radioEventsTitle">
      <div class="card radio-fs-inner">${head}${body}</div>
    </div>`;
  }
  return `<div class="card" id="radioEventsCard">${head}${body}</div>`;
}
function callQuality(q){
  if(q==null||q==="") return "—";
  const n=Number(q);
  if(Number.isNaN(n)) return String(q);
  if(n>5) return n+"%";
  return String(n)+"/5";
}
function sessionsPanel(r){
  const rows = (r.sessions||[]).slice().sort((a,b)=>(Number(b.connect)||0)-(Number(a.connect)||0));
  if(!rows.length){
    return `<div class="card"><h2 class="subtle" style="margin:0;font-size:13px;text-transform:uppercase">Sessions</h2>
      <p class="muted">No session records in this window.</p></div>`;
  }
  const radarN = rows.filter(s=>s.hitByRadar).length;
  const shortN = rows.filter(s=>s.duration!=null && s.duration<60).length;
  const openN = rows.filter(s=>s.disconnect==null || s.disconnect==="").length;
  return `<div class="card"><h2 class="subtle" style="margin:0 0 .35rem;font-size:13px;text-transform:uppercase">Sessions (${rows.length})</h2>
    <p class="muted" style="margin:0 0 .7rem;font-size:12px">Entire association history for this window, newest first. ${openN} open · ${radarN} during radar on that AP · ${shortN} under 60s. Scroll the table — nothing is truncated.</p>
    <div class="sess-scroll occ-scroll">
    <table class="ap-table">
      <thead><tr>
        <th>Connected</th><th>Disconnected</th><th>Duration</th><th>AP</th><th>SSID</th><th>Band</th><th></th>
      </tr></thead>
      <tbody>
      ${rows.map(s=>{
        const name = s.apName || fmtMac(s.ap||"");
        const mac = s.ap ? fmtMac(s.ap) : "";
        const showMac = s.apName && mac && !String(s.apName).includes(mac);
        return `<tr class="${s.hitByRadar?"radar":""}">
          <td class="mono">${esc(fmtTime(s.connect))}</td>
          <td class="mono">${s.disconnect?esc(fmtTime(s.disconnect)):'<span class="good">open</span>'}</td>
          <td class="mono ${s.duration!=null&&s.duration<60?"crit":""}">${esc(fmtDur(s.duration))}</td>
          <td class="mono break">${esc(name)}${showMac?" · "+esc(mac):""}</td>
          <td class="mono break">${esc(s.ssid||"—")}</td>
          <td class="mono">${esc(bandHz(s.band))}</td>
          <td>${s.hitByRadar?'<span class="pill crit">radar</span>':(s.duration!=null&&s.duration<60?'<span class="pill">short</span>':"")}</td>
        </tr>`;
      }).join("")}
      </tbody>
    </table>
    </div>
  </div>`;
}

function callsPanel(r){
  if(r.callsUnavailable && !(r.calls||[]).length){
    return `<div class="card"><h2 class="subtle" style="margin:0;font-size:13px;text-transform:uppercase">Teams / collaboration calls</h2>
      <p class="muted">No call records (${esc(r.callsUnavailable)}). Full Microsoft Teams QoS (jitter/loss/rating from Azure) needs the org's <span style="color:var(--fg)">Mist ↔ Teams</span> link under Organization → Settings → Integrations. Without it, Mist still returns wireless-detected Zoom/Teams sessions when the feature is licensed — otherwise this panel stays empty. Wireless RCA below still stands.</p></div>`;
  }
  const rows = r.calls||[];
  if(!rows.length){
    return `<div class="card"><h2 class="subtle" style="margin:0;font-size:13px;text-transform:uppercase">Teams / collaboration calls</h2>
      <p class="muted">No Teams/Zoom/Webex calls for this MAC in the last 7 days. If the user was on a call, either it was not classified or the Mist Teams integration is not linked.</p></div>`;
  }
  const teams = rows.filter(c=>c.teams);
  const poor = rows.filter(c=>c.poor);
  return `<div class="card"><h2 class="subtle" style="margin:0 0 .35rem;font-size:13px;text-transform:uppercase">Teams / collaboration calls (7 days)</h2>
    <p class="muted" style="margin:0 0 .7rem;font-size:12px">${teams.length} Microsoft Teams · ${rows.length} total collab · ${poor.length} poor audio/video/rating. Overlaps with deauth are listed under Correlated causes.</p>
    ${rows.slice(0,12).map(c=>`
      <div class="ev ${c.poor?"neg":""}">
        <div class="row"><span class="mono ${c.poor?"crit":"good"}">${esc(c.appLabel||c.app||"call")}${c.poor?" · poor":" · ok"}</span>
        <span class="mono subtle">${esc(fmtTime(c.start))}${c.end?" → "+fmtTime(c.end):""}</span></div>
        <div class="muted" style="font-size:12px">Audio ${esc(callQuality(c.audioQuality))} · Video ${esc(callQuality(c.videoQuality))}${c.rating!=null?" · user rating "+esc(c.rating):""} · ${esc(fmtDur(c.duration))}${c.meetingId?" · meeting "+esc(c.meetingId):""}</div>
      </div>`).join("")}
  </div>`;
}

function sessionRow(s){
  if(!s) return "";
  const name = s.apName || fmtMac(s.ap||"");
  const mac = s.ap ? fmtMac(s.ap) : "";
  const showMac = s.apName && mac && !String(s.apName).includes(mac);
  return `<tr class="radar">
    <td class="mono">${esc(fmtTime(s.connect))}</td>
    <td class="mono">${s.disconnect?esc(fmtTime(s.disconnect)):'<span class="good">open</span>'}</td>
    <td class="mono ${s.duration!=null&&s.duration<60?"crit":""}">${esc(fmtDur(s.duration))}</td>
    <td class="mono break">${esc(name)}${showMac?" · "+esc(mac):""}</td>
    <td class="mono break">${esc(s.ssid||"—")}</td>
    <td class="mono">${esc(bandHz(s.band))}</td>
    <td><span class="pill crit">radar</span></td>
  </tr>`;
}
function radioRow(ev){
  if(!ev) return "";
  const name = ev.apName || fmtMac(ev.ap||"");
  return `<tr class="radar pulse-c">
    <td class="mono subtle">${esc(fmtTime(ev.timestamp))}</td>
    <td class="mono break">${esc(name)} <span class="pill crit">on this client</span></td>
    <td class="mono">${esc(bandHz(ev.preUsage||ev.band))} → ${esc(bandHz(ev.usage||ev.band))}</td>
    <td class="mono">${arrow(ev.preChannel, ev.channel, "")}</td>
    <td class="mono">${arrow(ev.preBandwidth, ev.bandwidth, " MHz")}</td>
    <td class="mono">${arrow(ev.prePower, ev.power, " dBm")}</td>
    <td class="mono crit">${esc(ev.label||ev.event||"—")}</td>
  </tr>`;
}
function uniqueRadarAlerts(alerts){
  const seen=new Set();
  const out=[];
  for(const a of alerts||[]){
    const rt=a.radarTime!=null?a.radarTime:(a.radio&&a.radio.timestamp);
    const k=String(a.id||"")+"|"+(a.sessionAp||"")+"|"+Math.trunc(Number(a.sessionConnect)||0)+"|"+String(rt||"")+"|"+String(a.radarEvent||"");
    if(seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}
function radarAlertBanner(r){
  const alerts=uniqueRadarAlerts(r.radarAlerts||[]);
  if(!alerts.length) return "";
  const st = r.radioStoreStats||{};
  const n = (r.clientRadarEvents||[]).length;
  const statsBit = st.scanned!=null
    ? `<p class="muted" style="margin:.85rem 0 0;font-size:12px">Scanned ${esc(st.scanned)} site radio events · indexed ${esc(st.radars||0)} DFS/Post radar · ${n} overlapped this MAC's session on the same AP.</p>`
    : "";
  return alerts.map((a,i)=>{
    const radios = (a.radios && a.radios.length) ? a.radios : (a.radio ? [a.radio] : []);
    return `
    <div class="card pulse-c" style="border-color:color-mix(in oklab, var(--crit) 75%, var(--border));background:color-mix(in oklab, var(--crit) 10%, transparent)">
      <div class="row">
        <strong class="crit" style="font-size:13px;text-transform:uppercase;letter-spacing:.04em">Alert · session on radar AP</strong>
        <span class="pill crit">DFS${radios.length>1?" · "+radios.length:""}</span>
      </div>
      <p style="margin:.55rem 0 .85rem">${esc(a.summary||a.title||"")}</p>
      ${a.call?`<p class="muted" style="margin:0 0 .85rem;font-size:12px">Call in progress: <span class="mono">${esc(a.call)}${a.meetingId?" · meeting "+esc(a.meetingId):""}${a.callStart?" · "+esc(fmtTime(a.callStart)):""}${a.callEnd?" → "+esc(fmtTime(a.callEnd)):""}</span></p>`:""}
      <div class="subtle" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin:0 0 .35rem">This session</div>
      <div class="occ-scroll" style="margin-bottom:.9rem">
        <table class="ap-table">
          <thead><tr><th>Connected</th><th>Disconnected</th><th>Duration</th><th>AP</th><th>SSID</th><th>Band</th><th></th></tr></thead>
          <tbody>${sessionRow(a.session)}</tbody>
        </table>
      </div>
      <div class="subtle" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin:0 0 .35rem">${radios.length>1?"These radar events ("+radios.length+")":"This radar event"}</div>
      <div class="radar-scroll occ-scroll">
        <table class="ap-table">
          <thead><tr><th>Date</th><th>AP</th><th>Band</th><th>Channel</th><th>Width</th><th>Power</th><th>Event</th></tr></thead>
          <tbody>${radios.map(radioRow).join("")}</tbody>
        </table>
      </div>
      ${i===0?statsBit:""}
    </div>`;
  }).join("");
}

function correlationDetail(c){
  const d=c.detail; if(!d) return "";
  const rows=[];
  if(d.call) rows.push(["Teams / call", d.call+(d.meetingId?" · meeting "+d.meetingId:"")]);
  if(d.callStart) rows.push(["Call window", fmtTime(d.callStart)+(d.callEnd?" → "+fmtTime(d.callEnd):"")+(d.callDuration!=null?" ("+fmtDur(d.callDuration)+")":"")]);
  if(d.audioQuality!=null||d.videoQuality!=null) rows.push(["Call quality", "audio "+callQuality(d.audioQuality)+" · video "+callQuality(d.videoQuality)]);
  if(d.clientApName||d.clientAp) rows.push(["Client AP at that time", (d.clientApName?d.clientApName+" · ":"")+fmtMac(d.clientAp||"")]);
  if(d.radarEvent) rows.push(["Radar event", d.radarEvent+(d.radarType&&d.radarType!==d.radarEvent?" ("+d.radarType+")":"")]);
  if(d.radarTime) rows.push(["Radar timestamp", fmtTime(d.radarTime)]);
  if(d.radarApName||d.radarAp) rows.push(["Radar AP", (d.radarApName?d.radarApName+" · ":"")+fmtMac(d.radarAp||"")]);
  if(d.radarBand) rows.push(["Band", d.radarBand]);
  if(d.radarChannel) rows.push(["Channel", d.radarChannel]);
  if(d.radarWidth) rows.push(["Width", d.radarWidth]);
  if(d.radarPower) rows.push(["Power", d.radarPower]);
  if(d.dropType) rows.push(["Client event", d.dropType+(d.dropTime?" · "+fmtTime(d.dropTime):"")]);
  return `<dl>${rows.map(([k,v])=>`<dt>${esc(k)}</dt><dd class="mono break">${esc(v)}</dd>`).join("")}</dl>`;
}

function renderBoard(){
  const r=state.result; if(!r) return;
  const s=r.stats||{};
  const disconnects=(r.events||[]).filter(e=>/DEAUTH|DISASSOC|DISCONNECT/i.test(e.type)).length;
  const cors=r.verdict.correlations||[];
  const top=cors[0];
  const rcaSev=((r.radarAlerts||[]).length || (top&&top.severity==="crit")) ? "crit" : (top&&top.severity==="warn") ? "warn" : "info";
  const vt=rcaSev==="crit"?"crit":rcaSev==="warn"?"warn":"muted";
  const livePill = state.live ? `<span class="pill accent"><span class="dot"></span> live</span>` : "";
  $("viewBoard").innerHTML = `
    <div>
      <div class="subtle" style="font-size:12px;text-transform:uppercase">${esc(r.siteName)}</div>
      <h1 class="mono break">${esc(fmtMac(r.mac))}
        <span class="pill ${r.online?"good":"muted"}">${r.online?"seen":"stale"}</span>
        ${livePill}
        ${r.demo?'<span class="pill muted">sample</span>':""}
      </h1>
      <div class="subtle" style="font-size:12px">Last poll ${esc(fmtTime(r.fetchedAt))}</div>
    </div>
    <form class="toolbar" id="formBoard">
      <input class="mono" id="mac2" value="${esc(state.mac||fmtMac(r.mac))}"/>
      <select id="dur2"><option value="1h">1h</option><option value="6h">6h</option><option value="1d">1d</option><option value="1w">1w</option></select>
      <button class="btn btn-p" type="submit">Refresh</button>
      <button class="btn ${state.live?"btn-s":"btn-p"}" type="button" id="btnLive">${state.live?"Stop live":"Live monitor"}</button>
      <select id="liveSec">
        <option value="3">every 3s</option><option value="15">every 15s</option>
        <option value="30">every 30s</option><option value="60">every 60s</option>
      </select>
    </form>
    <p class="subtle" style="font-size:12px">Live mode re-queries client stats/events, 7-day radio events, Teams/Zoom calls, and the dominant AP's occupancy. Auto-pauses on Mist 429. 3s is aggressive.</p>
    ${radarAlertBanner(r)}
    ${(r.radarAlerts||[]).length ? "" : clientRadarPanel(r)}
    <div class="card ${rcaSev==="crit"||(r.radarAlerts||[]).length?"pulse-c":""}">
      <div class="subtle" style="font-size:12px;text-transform:uppercase;letter-spacing:.04em">RCA finding</div>
      <div class="${vt}" style="font-size:1.15rem;font-weight:650;margin-top:.35rem">${esc(r.verdict.primaryCause)}</div>
      <ul class="plain muted">${r.verdict.notes.map(n=>`<li>— ${esc(n)}</li>`).join("")}</ul>
    </div>
    <div class="card">
      <h2 class="subtle" style="margin:0;font-size:13px;text-transform:uppercase">Correlated causes</h2>
      ${!cors.length?'<p class="muted">No multi-signal pattern in this window.</p>':cors.map(c=>`
        <div class="ev ${c.highlight?"neg pulse-c":""}" style="border-color:color-mix(in oklab, var(--${c.severity==="info"?"border":c.severity}) 40%, var(--border))">
          <div class="row"><strong class="${c.severity==="crit"?"crit":c.severity==="warn"?"warn":"muted"}">${esc(c.title)}</strong>
          <span class="subtle" style="font-size:11px;text-transform:uppercase">${c.highlight?"on this AP · ":""}${esc(c.confidence)} · ${esc(c.severity)}</span></div>
          <p class="muted" style="margin:.4rem 0 0">${esc(c.evidence)}</p>
          ${c.highlight?correlationDetail(c):""}
        </div>`).join("")}
    </div>
    ${occPanel(r.apRadio)}
    ${radioEventsPanel(r)}
    ${callsPanel(r)}
    <div class="metrics">
      ${metric("RSSI", s.rssi!=null?s.rssi+" dBm":"—","Good ≥ −65 · Crit < −75", rssiBand(s.rssi))}
      ${metric("SNR", s.snr!=null?s.snr+" dB":"—","Good ≥ 25 · Crit < 15", snrBand(s.snr))}
      ${metric("Disconnects", String(disconnects), "Window "+r.duration, disconnects>=3?"crit":disconnects>=1?"warn":"good")}
      ${metric("TX retries", s.txRetries!=null?String(s.txRetries):"—", s.dualBand?"dual-band client":"retries", s.txRetries>=80?(rssiBand(s.rssi)==="good"?"warn":"crit"):"unknown")}
    </div>
    ${(state.live||state.samples.length>1)?`<div class="grid2">
      <div class="card"><div class="subtle" style="font-size:12px;text-transform:uppercase">RSSI over live polls</div>${spark(state.samples,"rssi")}</div>
      <div class="card"><div class="subtle" style="font-size:12px;text-transform:uppercase">SNR over live polls</div>${spark(state.samples,"snr")}</div>
    </div>`:""}
    <div class="card"><h2 class="subtle" style="margin:0;font-size:13px;text-transform:uppercase">Identity / radio</h2>
        ${!r.stats?'<p class="muted">No live stats for this MAC on the site.</p>':`<dl>
          <dt>Hostname</dt><dd class="mono break">${esc(s.hostname||"—")}</dd>
          <dt>User</dt><dd class="mono break">${esc(s.username||"—")}</dd>
          <dt>Vendor</dt><dd class="mono break">${esc(s.manufacture||"—")}</dd>
          <dt>SSID</dt><dd class="mono break">${esc(s.ssid||"—")}</dd>
          <dt>VLAN</dt><dd class="mono">${esc(s.vlan??"—")}</dd>
          <dt>IP</dt><dd class="mono break">${esc(s.ip||"—")}</dd>
          <dt>AP</dt><dd class="mono break">${esc(s.ap||"—")}</dd>
          <dt>Band / ch</dt><dd class="mono">${esc([s.band,s.channel].filter(x=>x!=null&&x!=="").join(" / ")||"—")}</dd>
          <dt>Protocol</dt><dd class="mono">${esc(s.proto||"—")}</dd>
          <dt>Key mgmt</dt><dd class="mono">${esc(s.keyMgmt||"—")}</dd>
          <dt>Tx / Rx</dt><dd class="mono">${esc((s.txRate??"—")+" / "+(s.rxRate??"—"))}</dd>
          <dt>Retries</dt><dd class="mono">${s.txRetries!=null?esc(s.txRetries+" tx / "+(s.rxRetries??"—")+" rx"):"—"}</dd>
          <dt>Uptime</dt><dd class="mono">${esc(fmtDur(s.uptime))}</dd>
          <dt>Last seen</dt><dd class="mono">${esc(fmtTime(s.lastSeen))}</dd>
          <dt>Bytes</dt><dd class="mono">${esc(fmtBytes(s.txBytes)+" / "+fmtBytes(s.rxBytes))}</dd>
        </dl>`}
      </div>
    ${sessionsPanel(r)}
    <div class="card"><h2 class="subtle" style="margin:0 0 .6rem;font-size:13px;text-transform:uppercase">Event timeline</h2>
      ${!(r.events||[]).length?'<p class="muted">No client events returned for this window.</p>':
        r.events.slice(0,40).map(ev=>`<div class="ev ${ev.negative?"neg":""}">
          <div class="row"><span class="mono ${ev.negative?"crit":"good"}">${ev.negative?"FAIL":"OK"} · ${esc(ev.type)}</span>
          <span class="mono subtle">${esc(fmtTime(ev.timestamp))}</span></div>
          ${ev.text?`<div>${esc(ev.text)}</div>`:""}
          <div class="muted" style="font-size:12px">AP ${esc(ev.ap||"—")} · ${esc(ev.ssid||"SSID —")} · ${esc(ev.band||"band —")}${ev.channel!=null&&ev.channel!==""?" / ch "+esc(ev.channel):""}${reason(ev.reason)?" · "+esc(reason(ev.reason)):""}</div>
        </div>`).join("")}
    </div>
    <div class="card"><h2 class="subtle" style="margin:0;font-size:13px;text-transform:uppercase">Marvis</h2>
      ${r.marvisUnavailable||!r.marvisText?'<p class="muted">Marvis Troubleshoot not available (no subscription, empty result, or API error). Events and RF still stand on their own.</p>':`<pre>${esc(r.marvisText)}</pre>`}
    </div>`;
  $("dur2").value=state.duration;
  $("liveSec").value=String(state.liveSec);
  $("formBoard").onsubmit=(e)=>{ e.preventDefault(); state.mac=$("mac2").value; state.duration=$("dur2").value; runDiag(false); };
  $("btnLive").onclick=()=>{ state.liveSec=Number($("liveSec").value); setLive(!state.live); renderBoard(); };
  $("liveSec").onchange=()=>{ state.liveSec=Number($("liveSec").value); if(state.live){ setLive(true); } };
  document.querySelectorAll("#occFilters [data-occ]").forEach(btn=>{
    btn.onclick=()=>{ state.occFilter=btn.getAttribute("data-occ")||"all"; renderBoard(); };
  });
  const btnFs=$("btnRadioFs");
  if(btnFs){
    btnFs.onclick=()=>{
      state.radioFs=!state.radioFs;
      document.body.classList.toggle("radio-fs-open", state.radioFs);
      renderBoard();
    };
  }
  document.body.classList.toggle("radio-fs-open", !!(state.radioFs && state.result));
}

// --- Idle wipe -------------------------------------------------------------
// The token has no persistence layer to expire, so the only lifetime control
// is this page. Any user interaction restarts the clock; a live poll counts
// only while the tab is visible, so an abandoned tab still wipes.
let idleTimer = null;
function wipeToken(msg){
  setLive(false);
  state.token=""; state.result=null; state.samples=[]; state.demo=false;
  state.orgs=[]; state.sites=[]; state.orgId=""; state.siteId="";
  state.email=""; state.radioFs=false;
  document.body.classList.remove("radio-fs-open");
  const tok=$("token"); if(tok) tok.value="";
  setSub(); show("viewConnect"); setErr(msg||"");
  if(idleTimer){ clearTimeout(idleTimer); idleTimer=null; }
}
function touchIdle(){
  if(idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(
    () => wipeToken("Session cleared after 30 minutes idle. Paste the token again to continue."),
    IDLE_WIPE_MS,
  );
}
["pointerdown","keydown","focusin"].forEach(evt =>
  document.addEventListener(evt, touchIdle, { passive:true, capture:true }));
document.addEventListener("visibilitychange", () => { if(!document.hidden) touchIdle(); });
touchIdle();

// The toolbox's Disconnect Console card can deep-link straight into the sample
// investigation, so a reviewer can see the output without a token.
if (location.hash === "#demo") $("btnDemo").click();
