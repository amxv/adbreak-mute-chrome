const MESSAGE_TYPES = {
  GET_STATE: "GET_STATE",
  SET_ENABLED: "SET_ENABLED",
  MUTE_ACTIVE_TAB: "MUTE_ACTIVE_TAB",
  UNMUTE_ACTIVE_TAB: "UNMUTE_ACTIVE_TAB",
};

const DEFAULT_ENABLED = true;

async function getEnabled() {
  const result = await chrome.storage.local.get("enabled");
  return typeof result.enabled === "boolean" ? result.enabled : DEFAULT_ENABLED;
}

async function setEnabled(enabled) {
  await chrome.storage.local.set({ enabled: Boolean(enabled) });
  return Boolean(enabled);
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function getState() {
  const [enabled, tab] = await Promise.all([getEnabled(), getActiveTab()]);

  return {
    enabled,
    tabId: tab?.id ?? null,
    muted: Boolean(tab?.mutedInfo?.muted),
  };
}

async function setActiveTabMuted(muted) {
  const tab = await getActiveTab();

  if (!tab?.id) {
    throw new Error("No active tab found.");
  }

  const updatedTab = await chrome.tabs.update(tab.id, { muted: Boolean(muted) });

  return {
    tabId: updatedTab.id,
    muted: Boolean(updatedTab.mutedInfo?.muted),
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  const result = await chrome.storage.local.get("enabled");

  if (typeof result.enabled !== "boolean") {
    await chrome.storage.local.set({ enabled: DEFAULT_ENABLED });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case MESSAGE_TYPES.GET_STATE: {
        const state = await getState();
        sendResponse({ ok: true, state });
        return;
      }

      case MESSAGE_TYPES.SET_ENABLED: {
        const enabled = await setEnabled(message.enabled);
        const state = await getState();
        sendResponse({ ok: true, enabled, state });
        return;
      }

      case MESSAGE_TYPES.MUTE_ACTIVE_TAB: {
        const result = await setActiveTabMuted(true);
        const state = await getState();
        sendResponse({ ok: true, ...result, state });
        return;
      }

      case MESSAGE_TYPES.UNMUTE_ACTIVE_TAB: {
        const result = await setActiveTabMuted(false);
        const state = await getState();
        sendResponse({ ok: true, ...result, state });
        return;
      }

      default:
        sendResponse({ ok: false, error: "Unknown message type." });
    }
  })().catch((error) => {
    sendResponse({ ok: false, error: error?.message || "Unexpected error." });
  });

  return true;
});
