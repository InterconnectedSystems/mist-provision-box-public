// The Mist Disconnect Console, v1.4, as one tool in the menu.
//
// Deliberately not rebuilt inside the toolbox shell. The console is a finished,
// parity-tested tool (182 assertions in tests/parity.test.js) whose controller
// binds to its own element IDs at module load, and whose UI wants a whole tab:
// a sticky header, full-screen radio-event overlays, Esc handling and wide
// tables. Opening console.html in its own tab keeps that code untouched and
// keeps its own 30-minute idle wipe governing its own token.
//
// The one visible cost is that the console asks for the token itself rather
// than inheriting the shell's — which is also why its token never has to cross
// a page boundary to get there.

const PAGE = "console.html";

export default {
  id: "disconnect-console",
  name: "Disconnect Console",
  description: "Root-cause a Wi-Fi client's disconnects: RF and SNR, 802.11 reason codes, DHCP "
    + "after roam, RRM channel occupancy, 7-day DFS radar, and Teams/Zoom call quality.",
  tag: "opens in its own tab",
  level: "Site · Client",
  // It collects its own credentials, so the menu never greys it out.
  needs: { mistToken: false },

  async mount(ctx) {
    const url = chrome.runtime.getURL(PAGE);
    ctx.mount.innerHTML = `
      <div class="card stack">
        <p class="muted" style="margin:0">
          This tool opens in its own tab, where it asks for a read-only Observer token of its own.
          It correlates a single client MAC against RF, roaming, RRM, radar and call-quality data
          and reports a ranked root cause.
        </p>
        <div class="actions">
          <button class="btn btn-p" id="dcOpen" type="button">Open Disconnect Console</button>
          <button class="btn btn-s" id="dcDemo" type="button">Open with the sample investigation</button>
        </div>
        <p class="subtle" style="font-size:12px;margin:0">
          Read-only: every request is an HTTPS GET to the Mist region you pick.
        </p>
      </div>`;
    const open = (hash) => window.open(hash ? `${url}#${hash}` : url, "_blank", "noopener");
    ctx.mount.querySelector("#dcOpen").onclick = () => open("");
    ctx.mount.querySelector("#dcDemo").onclick = () => open("demo");
  },

  // mount() owns the view; run() exists so the tool shape stays uniform.
  async run() {
    return { rendered: true };
  },
};
