// The SSR Pre/Post Check, as one tool in the menu.
//
// The check itself lives in ssr/ssr-pre-post.js and runs in ssr.html, its own
// tab. It talks to a Juniper SSR Conductor at a host only the user knows, and
// the toolbox page's security policy only lets it reach the Mist regions, so
// that it can never send the Mist token anywhere else. A page of its own lets
// SSR reach the Conductor without loosening that.

const PAGE = "ssr.html";

export default {
  id: "ssr-pre-post",
  name: "SSR Pre/Post Check",
  description: "Snapshot BGP, OSPF, interfaces, adjacencies, node status, sessions and alarms "
    + "across an SSR Conductor's routers before a change, then again after, and diff every "
    + "value that moved.",
  tag: "opens in its own tab",
  level: "SSR Conductor",
  // It collects its own credentials, so the menu never greys it out.
  needs: { mistToken: false },

  async mount(ctx) {
    const url = chrome.runtime.getURL(PAGE);
    ctx.mount.innerHTML = `
      <div class="card stack">
        <p class="muted" style="margin:0">
          This tool opens in its own tab, where it asks for the Conductor's address, a username and
          a password. It does not use your Mist token.
        </p>
        <div class="actions">
          <button class="btn btn-p" id="ssrOpen" type="button">Open SSR Pre/Post Check</button>
        </div>
      </div>`;
    ctx.mount.querySelector("#ssrOpen").onclick = () => window.open(url, "_blank", "noopener");
  },

  // mount() owns the view; run() exists so the tool shape stays uniform.
  async run() {
    return { rendered: true };
  },
};
