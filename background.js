const MESSAGE_TYPES = {
  GET_STATE: "GET_STATE",
  SET_ENABLED: "SET_ENABLED",
  START_MONITORING_CURRENT_TAB: "START_MONITORING_CURRENT_TAB",
  STOP_MONITORING: "STOP_MONITORING",
  CAPTURE_IPL_TEMPLATE: "CAPTURE_IPL_TEMPLATE",
  CAPTURE_TEAM_TEMPLATE: "CAPTURE_TEAM_TEMPLATE",
  CLEAR_TEMPLATES: "CLEAR_TEMPLATES",
};

const OFFSCREEN_MESSAGE_TYPES = {
  BUILD_TEMPLATE: "OFFSCREEN_BUILD_TEMPLATE",
  MATCH_FRAME: "OFFSCREEN_MATCH_FRAME",
};

const STORAGE_KEY = "appState";
const MONITOR_ALARM = "monitor-sample";
const SAMPLE_INTERVAL_MS = 1200;

const DEFAULT_STATE = {
  enabled: true,
  monitoring: false,
  monitoredTabId: null,
  monitoredWindowId: null,
  templates: {
    ipl: null,
    team: null,
  },
  runtime: {
    matchLabel: "Unknown",
    matchScore: null,
    lastDecision: "Idle.",
    statusMessage: "Capture the IPL logo, optionally capture the home team logo, then start monitoring.",
    lastError: null,
    autoMuted: false,
    muted: null,
    mutedReason: null,
    lastCaptureAt: null,
  },
};

let monitorTickRunning = false;
let offscreenCreationPromise = null;

function withDefaults(state = {}) {
  const templates = state.templates || {};
  const runtime = state.runtime || {};

  return {
    enabled: typeof state.enabled === "boolean" ? state.enabled : DEFAULT_STATE.enabled,
    monitoring: Boolean(state.monitoring),
    monitoredTabId: Number.isInteger(state.monitoredTabId) ? state.monitoredTabId : null,
    monitoredWindowId: Number.isInteger(state.monitoredWindowId) ? state.monitoredWindowId : null,
    templates: {
      ipl: isValidTemplate(templates.ipl) ? templates.ipl : null,
      team: isValidTemplate(templates.team) ? templates.team : null,
    },
    runtime: {
      matchLabel:
        typeof runtime.matchLabel === "string" ? runtime.matchLabel : DEFAULT_STATE.runtime.matchLabel,
      matchScore: Number.isFinite(Number(runtime.matchScore)) ? Number(runtime.matchScore) : null,
      lastDecision:
        typeof runtime.lastDecision === "string"
          ? runtime.lastDecision
          : DEFAULT_STATE.runtime.lastDecision,
      statusMessage:
        typeof runtime.statusMessage === "string"
          ? runtime.statusMessage
          : DEFAULT_STATE.runtime.statusMessage,
      lastError:
        typeof runtime.lastError === "string" ? runtime.lastError : DEFAULT_STATE.runtime.lastError,
      autoMuted: Boolean(runtime.autoMuted),
      muted: typeof runtime.muted === "boolean" ? runtime.muted : DEFAULT_STATE.runtime.muted,
      mutedReason:
        typeof runtime.mutedReason === "string" ? runtime.mutedReason : DEFAULT_STATE.runtime.mutedReason,
      lastCaptureAt: Number.isFinite(Number(runtime.lastCaptureAt))
        ? Number(runtime.lastCaptureAt)
        : DEFAULT_STATE.runtime.lastCaptureAt,
    },
  };
}

function isValidTemplate(template) {
  if (!template || typeof template !== "object") {
    return false;
  }

  if (typeof template.label !== "string" || !template.label) {
    return false;
  }

  if (!Array.isArray(template.segments) || !template.segments.length) {
    return false;
  }

  return template.segments.every((segment) => {
    if (!segment || typeof segment !== "object") {
      return false;
    }

    if (!Array.isArray(segment.data) || !segment.data.length) {
      return false;
    }

    return Number.isFinite(Number(segment.width)) && Number.isFinite(Number(segment.height));
  });
}

async function getStoredState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return withDefaults(stored[STORAGE_KEY]);
}

async function setStoredState(nextState) {
  const normalized = withDefaults(nextState);
  await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
  return normalized;
}

async function initializeState() {
  const current = await getStoredState();
  await setStoredState(current);
}

async function getTabSafe(tabId) {
  if (!Number.isInteger(tabId)) {
    return null;
  }

  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function getActiveTabCurrentWindow() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function buildCaptureFailureMessage(error) {
  const reason = error?.message || "Unknown capture error.";
  return `Frame capture failed (${reason}). Some streams block screenshots or return blank frames.`;
}

async function clearMonitorAlarm() {
  await chrome.alarms.clear(MONITOR_ALARM);
}

async function scheduleNextMonitorTick(delayMs = SAMPLE_INTERVAL_MS) {
  await chrome.alarms.create(MONITOR_ALARM, {
    when: Date.now() + Math.max(150, delayMs),
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function hasOffscreenDocument() {
  if (typeof chrome.runtime.getContexts !== "function") {
    return false;
  }

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen.html")],
  });

  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  if (!offscreenCreationPromise) {
    offscreenCreationPromise = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS"],
        justification: "Process screenshots in canvas outside the service worker.",
      })
      .catch((error) => {
        if (!String(error?.message || "").includes("single offscreen")) {
          throw error;
        }
      })
      .finally(() => {
        offscreenCreationPromise = null;
      });
  }

  await offscreenCreationPromise;
}

async function sendOffscreenMessage(message) {
  await ensureOffscreenDocument();

  const response = await chrome.runtime.sendMessage(message);

  if (!response?.ok) {
    throw new Error(response?.error || "Offscreen processing failed.");
  }

  return response;
}

async function stopMonitoring(state, reason) {
  const next = withDefaults(state);

  await clearMonitorAlarm();

  if (next.runtime.autoMuted && Number.isInteger(next.monitoredTabId)) {
    const tab = await getTabSafe(next.monitoredTabId);

    if (tab?.mutedInfo?.muted && tab.mutedInfo.reason === "extension") {
      try {
        const updated = await chrome.tabs.update(tab.id, { muted: false });
        next.runtime.muted = Boolean(updated.mutedInfo?.muted);
        next.runtime.mutedReason = updated.mutedInfo?.reason ?? null;
      } catch (error) {
        next.runtime.lastError = `Failed to restore tab mute state: ${error?.message || "Unknown error."}`;
      }
    }
  }

  next.monitoring = false;
  next.runtime.autoMuted = false;
  next.runtime.matchLabel = "Unknown";
  next.runtime.matchScore = null;
  next.runtime.lastDecision = reason;
  next.runtime.statusMessage = reason;

  return withDefaults(next);
}

async function buildPopupState(preloadedState = null) {
  const state = preloadedState ? withDefaults(preloadedState) : await getStoredState();
  const [currentTab, monitoredTab] = await Promise.all([
    getActiveTabCurrentWindow(),
    getTabSafe(state.monitoredTabId),
  ]);

  return {
    enabled: state.enabled,
    monitoring: state.monitoring,
    currentTabId: currentTab?.id ?? null,
    currentWindowId: currentTab?.windowId ?? null,
    monitoredTabId: monitoredTab?.id ?? state.monitoredTabId,
    monitoredWindowId: monitoredTab?.windowId ?? state.monitoredWindowId,
    monitoredTabTitle: monitoredTab?.title ?? null,
    isCurrentTabMonitored: Boolean(currentTab?.id && monitoredTab?.id && currentTab.id === monitoredTab.id),
    hasIplTemplate: Boolean(state.templates.ipl),
    hasTeamTemplate: Boolean(state.templates.team),
    matchLabel: state.runtime.matchLabel,
    matchScore: state.runtime.matchScore,
    lastDecision: state.runtime.lastDecision,
    statusMessage: state.runtime.statusMessage,
    lastError: state.runtime.lastError,
    muted: monitoredTab ? Boolean(monitoredTab.mutedInfo?.muted) : state.runtime.muted,
    mutedReason: monitoredTab?.mutedInfo?.reason ?? state.runtime.mutedReason,
    autoMuted: state.runtime.autoMuted,
    lastCaptureAt: state.runtime.lastCaptureAt,
  };
}

async function captureVisibleFromTab(tab) {
  const liveTab = await getTabSafe(tab.id);

  if (!liveTab?.id) {
    throw new Error("Target tab is no longer available.");
  }

  const windowId = liveTab.windowId;
  const activeTabs = await chrome.tabs.query({ active: true, windowId });
  const previousActiveTabId = activeTabs[0]?.id ?? null;
  let switchedTabs = false;

  if (previousActiveTabId !== liveTab.id) {
    await chrome.tabs.update(liveTab.id, { active: true });
    switchedTabs = true;
    await delay(200);
  }

  let dataUrl;

  try {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (error) {
    throw new Error(buildCaptureFailureMessage(error));
  } finally {
    if (switchedTabs && Number.isInteger(previousActiveTabId) && previousActiveTabId !== liveTab.id) {
      try {
        await chrome.tabs.update(previousActiveTabId, { active: true });
      } catch {
        // Best effort only.
      }
    }
  }

  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image")) {
    throw new Error("Capture returned an invalid frame.");
  }

  return {
    dataUrl,
    tabId: liveTab.id,
    windowId,
    title: liveTab.title ?? "",
  };
}

async function captureTemplate(kind) {
  const activeTab = await getActiveTabCurrentWindow();

  if (!activeTab?.id) {
    throw new Error("No active tab found in the current window.");
  }

  const capture = await captureVisibleFromTab(activeTab);
  const template = await sendOffscreenMessage({
    type: OFFSCREEN_MESSAGE_TYPES.BUILD_TEMPLATE,
    dataUrl: capture.dataUrl,
    label: kind === "ipl" ? "IPL logo" : "Home team logo",
  });

  let state = await getStoredState();
  state.monitoredTabId = capture.tabId;
  state.monitoredWindowId = capture.windowId;
  state.templates[kind] = template.template;
  state.runtime.lastError = null;
  state.runtime.lastDecision = `${template.template.label} captured from current tab.`;
  state.runtime.statusMessage = `${template.template.label} saved. ${
    state.templates.ipl ? "You can start monitoring." : "Capture the IPL logo first."
  }`;
  state = await setStoredState(state);

  return {
    state: await buildPopupState(state),
  };
}

async function runMonitorTick() {
  if (monitorTickRunning) {
    await scheduleNextMonitorTick();
    return;
  }

  monitorTickRunning = true;

  try {
    let state = await getStoredState();

    if (!state.enabled || !state.monitoring) {
      await clearMonitorAlarm();
      return;
    }

    const monitoredTab = await getTabSafe(state.monitoredTabId);

    if (!monitoredTab) {
      state = await stopMonitoring(state, "Monitored tab is no longer available.");
      state.monitoredTabId = null;
      state.monitoredWindowId = null;
      await setStoredState(state);
      return;
    }

    state.runtime.muted = Boolean(monitoredTab.mutedInfo?.muted);
    state.runtime.mutedReason = monitoredTab.mutedInfo?.reason ?? null;

    if (!state.templates.ipl) {
      state = await stopMonitoring(state, "Capture the IPL logo before monitoring.");
      await setStoredState(state);
      return;
    }

    let dataUrl;

    try {
      dataUrl = await chrome.tabs.captureVisibleTab(monitoredTab.windowId, { format: "png" });
    } catch (error) {
      const message = buildCaptureFailureMessage(error);
      state.runtime.lastError = message;
      state.runtime.statusMessage = message;
      state.runtime.lastDecision = "Capture failed; mute state unchanged.";
      await setStoredState(state);
      await scheduleNextMonitorTick();
      return;
    }

    const templates = [state.templates.ipl, state.templates.team].filter(Boolean);

    let matchResult;

    try {
      matchResult = await sendOffscreenMessage({
        type: OFFSCREEN_MESSAGE_TYPES.MATCH_FRAME,
        dataUrl,
        templates,
      });
    } catch (error) {
      const message = `Image processing failed (${error?.message || "unknown"}).`;
      state.runtime.lastError = message;
      state.runtime.statusMessage = message;
      state.runtime.lastDecision = "Frame processing failed; mute state unchanged.";
      await setStoredState(state);
      await scheduleNextMonitorTick();
      return;
    }

    state.runtime.lastCaptureAt = Date.now();
    state.runtime.matchLabel = matchResult.matchLabel;
    state.runtime.matchScore = matchResult.matchScore;

    if (matchResult.isBlank) {
      const message = "Captured frame looks blank or blocked. The streaming site may be protecting video frames.";
      state.runtime.lastError = message;
      state.runtime.statusMessage = message;
      state.runtime.lastDecision = "Blank frame detected; mute state unchanged.";
      await setStoredState(state);
      await scheduleNextMonitorTick();
      return;
    }

    state.runtime.lastError = null;

    if (matchResult.logoPresent) {
      if (state.runtime.autoMuted && state.runtime.muted && state.runtime.mutedReason === "extension") {
        const updated = await chrome.tabs.update(monitoredTab.id, { muted: false });
        state.runtime.autoMuted = false;
        state.runtime.muted = Boolean(updated.mutedInfo?.muted);
        state.runtime.mutedReason = updated.mutedInfo?.reason ?? null;
        state.runtime.lastDecision = `${matchResult.matchLabel} detected; tab auto-unmuted.`;
      } else {
        state.runtime.autoMuted = false;
        state.runtime.lastDecision = `${matchResult.matchLabel} detected; tab kept unmuted.`;
      }
    } else if (!state.runtime.muted) {
      const updated = await chrome.tabs.update(monitoredTab.id, { muted: true });
      state.runtime.autoMuted = true;
      state.runtime.muted = Boolean(updated.mutedInfo?.muted);
      state.runtime.mutedReason = updated.mutedInfo?.reason ?? null;
      state.runtime.lastDecision = "No saved logo detected; tab auto-muted.";
    } else if (state.runtime.mutedReason === "user") {
      state.runtime.autoMuted = false;
      state.runtime.lastDecision = "No saved logo detected; tab already muted by user.";
    } else {
      state.runtime.lastDecision = "No saved logo detected; tab remains muted.";
    }

    const scoreText = Number.isFinite(state.runtime.matchScore)
      ? `match score ${state.runtime.matchScore.toFixed(3)}`
      : "match score unavailable";
    state.runtime.statusMessage = matchResult.logoPresent
      ? `${matchResult.matchLabel} found in top-left region; ${scoreText}.`
      : `No saved logo found in top-left region; ${scoreText}.`;

    await setStoredState(state);

    if (state.enabled && state.monitoring) {
      await scheduleNextMonitorTick();
    }
  } finally {
    monitorTickRunning = false;
  }
}

async function handleMessage(message) {
  switch (message.type) {
    case MESSAGE_TYPES.GET_STATE: {
      return { state: await buildPopupState() };
    }

    case MESSAGE_TYPES.SET_ENABLED: {
      let state = await getStoredState();
      state.enabled = Boolean(message.enabled);

      if (!state.enabled && state.monitoring) {
        state = await stopMonitoring(state, "Monitoring stopped because extension was disabled.");
      }

      if (state.enabled && !state.monitoring) {
        state.runtime.lastError = null;
        state.runtime.lastDecision = "Extension enabled.";
        state.runtime.statusMessage = "Capture the IPL logo, then start monitoring.";
      }

      state = await setStoredState(state);
      return { state: await buildPopupState(state) };
    }

    case MESSAGE_TYPES.CAPTURE_IPL_TEMPLATE:
      return captureTemplate("ipl");

    case MESSAGE_TYPES.CAPTURE_TEAM_TEMPLATE:
      return captureTemplate("team");

    case MESSAGE_TYPES.CLEAR_TEMPLATES: {
      let state = await getStoredState();
      state.templates = { ipl: null, team: null };
      state.runtime.lastError = null;
      state.runtime.matchLabel = "Unknown";
      state.runtime.matchScore = null;
      state.runtime.lastDecision = "Saved logos cleared.";
      state.runtime.statusMessage = "Capture the IPL logo again before monitoring.";

      if (state.monitoring) {
        state = await stopMonitoring(state, "Monitoring stopped because saved logos were cleared.");
      }

      state = await setStoredState(state);
      return { state: await buildPopupState(state) };
    }

    case MESSAGE_TYPES.START_MONITORING_CURRENT_TAB: {
      const tab = await getActiveTabCurrentWindow();

      if (!tab?.id) {
        throw new Error("No active tab found in current window.");
      }

      let state = await getStoredState();

      if (!state.enabled) {
        throw new Error("Enable the extension before starting monitoring.");
      }

      if (!state.templates.ipl) {
        throw new Error("Capture the IPL logo before starting monitoring.");
      }

      state.monitoring = true;
      state.monitoredTabId = tab.id;
      state.monitoredWindowId = tab.windowId;
      state.runtime.lastError = null;
      state.runtime.matchLabel = "Unknown";
      state.runtime.matchScore = null;
      state.runtime.lastDecision = "Monitoring started for current tab.";
      state.runtime.statusMessage = "Monitoring active. Waiting for the next sample.";
      state.runtime.autoMuted = false;
      state.runtime.muted = Boolean(tab.mutedInfo?.muted);
      state.runtime.mutedReason = tab.mutedInfo?.reason ?? null;
      state.runtime.lastCaptureAt = null;

      await clearMonitorAlarm();
      state = await setStoredState(state);
      await scheduleNextMonitorTick(250);

      return { state: await buildPopupState(state) };
    }

    case MESSAGE_TYPES.STOP_MONITORING: {
      let state = await getStoredState();
      state = await stopMonitoring(state, "Monitoring stopped by user.");
      state = await setStoredState(state);
      return { state: await buildPopupState(state) };
    }

    default:
      throw new Error("Unknown message type.");
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await initializeState();
});

chrome.runtime.onStartup.addListener(async () => {
  await initializeState();

  const state = await getStoredState();

  if (state.enabled && state.monitoring) {
    await scheduleNextMonitorTick(500);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  let state = await getStoredState();

  if (state.monitoredTabId === tabId) {
    state = await stopMonitoring(state, "Monitored tab was closed.");
    state.monitoredTabId = null;
    state.monitoredWindowId = null;
    await setStoredState(state);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== MONITOR_ALARM) {
    return;
  }

  runMonitorTick().catch(async (error) => {
    const state = await getStoredState();
    state.runtime.lastError = `Monitoring failure: ${error?.message || "Unknown error."}`;
    state.runtime.statusMessage = state.runtime.lastError;
    state.runtime.lastDecision = "Monitoring encountered an error.";
    await setStoredState(state);
    if (state.enabled && state.monitoring) {
      await scheduleNextMonitorTick();
    }
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const knownMessage = Object.values(MESSAGE_TYPES).includes(message?.type);

  if (!knownMessage) {
    return false;
  }

  handleMessage(message)
    .then((result) => {
      sendResponse({ ok: true, ...result });
    })
    .catch((error) => {
      sendResponse({ ok: false, error: error?.message || "Unexpected error." });
    });

  return true;
});

initializeState().catch(() => {
  // Keep startup resilient if initialization fails; next user action retries through handlers.
});
