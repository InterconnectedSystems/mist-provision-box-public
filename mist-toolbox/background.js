// Opens or focuses the toolbox tab. That is the whole job.
//
// It never sees a credential: the page holds the Mist token (and any SSR
// password) in memory and talks to the APIs itself, so there is no message
// boundary for a secret to cross and no long-running work for MV3's ~30s idle
// timer to kill mid-scan.
//
// No "permissions" are declared. action.onClicked and tabs.create need none,
// and runtime.getContexts reports this extension's own tabs without the "tabs"
// permission, which querying by URL would have required.

const TOOLBOX_PATH = "toolbox.html";

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL(TOOLBOX_PATH);
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["TAB"],
      documentUrls: [url],
    });
    const open = contexts.find((c) => c.tabId !== undefined && c.tabId !== -1);
    if (open) {
      await chrome.tabs.update(open.tabId, { active: true });
      if (open.windowId !== undefined && open.windowId !== -1) {
        await chrome.windows.update(open.windowId, { focused: true });
      }
      return;
    }
  } catch {
    // getContexts is unavailable or the window is gone — fall through and open a new tab.
  }
  await chrome.tabs.create({ url });
});
