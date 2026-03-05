const MESSAGE_TYPES = {
  GET_STATE: "GET_STATE",
  SET_ENABLED: "SET_ENABLED",
  START_MONITORING_CURRENT_TAB: "START_MONITORING_CURRENT_TAB",
  STOP_MONITORING: "STOP_MONITORING",
  OPEN_OPTIONS: "OPEN_OPTIONS",
  GET_OPTIONS_STATE: "GET_OPTIONS_STATE",
  CAPTURE_CALIBRATION_FRAME: "CAPTURE_CALIBRATION_FRAME",
  SAVE_SETTINGS: "SAVE_SETTINGS",
  SAVE_CALIBRATION: "SAVE_CALIBRATION",
};

const OFFSCREEN_MESSAGE_TYPES = {
  PROCESS_FRAME: "OFFSCREEN_PROCESS_FRAME",
};

const STORAGE_KEY = "appState";
const MONITOR_ALARM = "monitor-sample";
const SAMPLE_INTERVAL_MS = 1000;

const DEFAULT_STATE = {
  enabled: true,
  monitoring: false,
  monitoredTabId: null,
  monitoredWindowId: null,
  calibrationTarget: null,
  calibration: {
    roi: null,
    referenceHash: null,
    threshold: 10,
    absentSamplesToMute: 3,
    presentSamplesToUnmute: 2,
  },
  runtime: {
    logoPresent: null,
    lastDistance: null,
    lastDecision: "Idle.",
    statusMessage: "Not monitoring.",
    lastError: null,
    autoMuted: false,
    consecutiveAbsent: 0,
    consecutivePresent: 0,
    muted: null,
    mutedReason: null,
    lastCaptureAt: null,
  },
};

let monitorTickRunning = false;
let offscreenCreationPromise = null;

function clampInteger(value, min, max, fallback) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  const integerValue = Math.round(numericValue);
  return Math.min(max, Math.max(min, integerValue));
}

function nonNegativeInteger(value, fallback) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  const integerValue = Math.round(numericValue);
  return integerValue < 0 ? fallback : integerValue;
}

function isValidRoi(roi) {
  if (!roi || typeof roi !== "object") {
    return false;
  }

  const keys = ["x", "y", "w", "h"];

  return keys.every((key) => Number.isFinite(Number(roi[key])));
}

function normalizeRoi(roi) {
  const x = Number(roi.x);
  const y = Number(roi.y);
  const w = Number(roi.w);
  const h = Number(roi.h);

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
    return null;
  }

  const boundedX = Math.min(0.99, Math.max(0, x));
  const boundedY = Math.min(0.99, Math.max(0, y));
  const boundedW = Math.min(1 - boundedX, Math.max(0.005, w));
  const boundedH = Math.min(1 - boundedY, Math.max(0.005, h));

  return {
    x: Number(boundedX.toFixed(6)),
    y: Number(boundedY.toFixed(6)),
    w: Number(boundedW.toFixed(6)),
    h: Number(boundedH.toFixed(6)),
  };
}

function withDefaults(state = {}) {
  const calibration = state.calibration || {};
  const runtime = state.runtime || {};
  const calibrationTarget = state.calibrationTarget;

  const normalizedTarget =
    calibrationTarget &&
    typeof calibrationTarget === "object" &&
    Number.isInteger(calibrationTarget.tabId) &&
    Number.isInteger(calibrationTarget.windowId)
      ? {
          tabId: calibrationTarget.tabId,
          windowId: calibrationTarget.windowId,
        }
      : null;

  return {
    enabled: typeof state.enabled === "boolean" ? state.enabled : DEFAULT_STATE.enabled,
    monitoring: Boolean(state.monitoring),
    monitoredTabId: Number.isInteger(state.monitoredTabId) ? state.monitoredTabId : null,
    monitoredWindowId: Number.isInteger(state.monitoredWindowId) ? state.monitoredWindowId : null,
    calibrationTarget: normalizedTarget,
    calibration: {
      roi: isValidRoi(calibration.roi) ? normalizeRoi(calibration.roi) : null,
      referenceHash:
        typeof calibration.referenceHash === "string" && /^[0-9a-f]{16}$/i.test(calibration.referenceHash)
          ? calibration.referenceHash.toLowerCase()
          : null,
      threshold: clampInteger(
        calibration.threshold,
        0,
        64,
        DEFAULT_STATE.calibration.threshold,
      ),
      absentSamplesToMute: clampInteger(
        calibration.absentSamplesToMute,
        1,
        20,
        DEFAULT_STATE.calibration.absentSamplesToMute,
      ),
      presentSamplesToUnmute: clampInteger(
        calibration.presentSamplesToUnmute,
        1,
        20,
        DEFAULT_STATE.calibration.presentSamplesToUnmute,
      ),
    },
    runtime: {
      logoPresent:
        typeof runtime.logoPresent === "boolean" ? runtime.logoPresent : DEFAULT_STATE.runtime.logoPresent,
      lastDistance: Number.isFinite(Number(runtime.lastDistance))
        ? Number(runtime.lastDistance)
        : DEFAULT_STATE.runtime.lastDistance,
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
      consecutiveAbsent: nonNegativeInteger(runtime.consecutiveAbsent, 0),
      consecutivePresent: nonNegativeInteger(runtime.consecutivePresent, 0),
      muted: typeof runtime.muted === "boolean" ? runtime.muted : DEFAULT_STATE.runtime.muted,
      mutedReason:
        typeof runtime.mutedReason === "string" ? runtime.mutedReason : DEFAULT_STATE.runtime.mutedReason,
      lastCaptureAt: Number.isFinite(Number(runtime.lastCaptureAt))
        ? Number(runtime.lastCaptureAt)
        : DEFAULT_STATE.runtime.lastCaptureAt,
    },
  };
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

  return `Frame capture failed (${reason}). This can happen on DRM/protected video. Use manual mute/hotkey fallback.`;
}

async function clearMonitorAlarm() {
  await chrome.alarms.clear(MONITOR_ALARM);
}

async function scheduleNextMonitorTick(delayMs = SAMPLE_INTERVAL_MS) {
  await chrome.alarms.create(MONITOR_ALARM, {
    when: Date.now() + Math.max(100, delayMs),
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
        justification: "Compute dHash and frame statistics via canvas outside the service worker.",
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

async function processFrameInOffscreen({ dataUrl, roi, referenceHash, threshold }) {
  await ensureOffscreenDocument();

  const response = await chrome.runtime.sendMessage({
    type: OFFSCREEN_MESSAGE_TYPES.PROCESS_FRAME,
    dataUrl,
    roi,
    referenceHash,
    threshold,
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Offscreen image processing failed.");
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
  next.runtime.logoPresent = null;
  next.runtime.consecutiveAbsent = 0;
  next.runtime.consecutivePresent = 0;
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
    calibrationReady: Boolean(state.calibration.roi && state.calibration.referenceHash),
    logoPresent: state.runtime.logoPresent,
    lastDistance: state.runtime.lastDistance,
    lastDecision: state.runtime.lastDecision,
    statusMessage: state.runtime.statusMessage,
    lastError: state.runtime.lastError,
    muted: monitoredTab ? Boolean(monitoredTab.mutedInfo?.muted) : state.runtime.muted,
    mutedReason: monitoredTab?.mutedInfo?.reason ?? state.runtime.mutedReason,
    autoMuted: state.runtime.autoMuted,
    threshold: state.calibration.threshold,
    absentSamplesToMute: state.calibration.absentSamplesToMute,
    presentSamplesToUnmute: state.calibration.presentSamplesToUnmute,
  };
}

async function resolveCalibrationTarget(state) {
  const next = withDefaults(state);

  const candidate = next.calibrationTarget ||
    (Number.isInteger(next.monitoredTabId) && Number.isInteger(next.monitoredWindowId)
      ? {
          tabId: next.monitoredTabId,
          windowId: next.monitoredWindowId,
        }
      : null);

  if (!candidate) {
    return { state: next, target: null, targetTab: null };
  }

  const targetTab = await getTabSafe(candidate.tabId);

  if (!targetTab) {
    next.calibrationTarget = null;
    return { state: next, target: null, targetTab: null };
  }

  const target = { tabId: targetTab.id, windowId: targetTab.windowId };
  next.calibrationTarget = target;

  return { state: next, target, targetTab };
}

async function buildOptionsState(preloadedState = null) {
  let state = preloadedState ? withDefaults(preloadedState) : await getStoredState();
  const resolved = await resolveCalibrationTarget(state);
  state = resolved.state;

  return {
    calibration: state.calibration,
    monitoring: state.monitoring,
    monitoredTabId: state.monitoredTabId,
    targetTab: resolved.targetTab
      ? {
          id: resolved.targetTab.id,
          windowId: resolved.targetTab.windowId,
          title: resolved.targetTab.title ?? "",
          url: resolved.targetTab.url ?? "",
          active: Boolean(resolved.targetTab.active),
        }
      : null,
    statusMessage: state.runtime.statusMessage,
    lastError: state.runtime.lastError,
  };
}

async function captureVisibleFromTargetTab(target) {
  const targetTab = await getTabSafe(target.tabId);

  if (!targetTab?.id) {
    throw new Error("Calibration target tab is no longer available.");
  }

  const targetWindowId = targetTab.windowId;
  const activeTabs = await chrome.tabs.query({ active: true, windowId: targetWindowId });
  const previousActiveTabId = activeTabs[0]?.id ?? null;

  let switchedTabs = false;

  if (previousActiveTabId !== targetTab.id) {
    await chrome.tabs.update(targetTab.id, { active: true });
    switchedTabs = true;
    await delay(180);
  }

  let dataUrl;

  try {
    dataUrl = await chrome.tabs.captureVisibleTab(targetWindowId, { format: "png" });
  } catch (error) {
    throw new Error(buildCaptureFailureMessage(error));
  } finally {
    if (
      switchedTabs &&
      Number.isInteger(previousActiveTabId) &&
      previousActiveTabId !== targetTab.id
    ) {
      try {
        await chrome.tabs.update(previousActiveTabId, { active: true });
      } catch {
        // Best effort only.
      }
    }
  }

  return {
    dataUrl,
    tabId: targetTab.id,
    windowId: targetWindowId,
    title: targetTab.title ?? "",
    url: targetTab.url ?? "",
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
      await clearMonitorAlarm();
      return;
    }

    state.monitoredTabId = monitoredTab.id;
    state.monitoredWindowId = monitoredTab.windowId;
    state.runtime.muted = Boolean(monitoredTab.mutedInfo?.muted);
    state.runtime.mutedReason = monitoredTab.mutedInfo?.reason ?? null;

    if (state.runtime.autoMuted && state.runtime.mutedReason === "user") {
      state.runtime.autoMuted = false;
    }

    if (!state.calibration.roi || !state.calibration.referenceHash) {
      state.runtime.logoPresent = null;
      state.runtime.consecutiveAbsent = 0;
      state.runtime.consecutivePresent = 0;
      state.runtime.lastDecision = "Waiting for calibration.";
      state.runtime.statusMessage = "Calibration required before monitoring can detect logo changes.";
      state.runtime.lastError = null;
      await setStoredState(state);
      await scheduleNextMonitorTick();
      return;
    }

    if (!monitoredTab.active) {
      state.runtime.logoPresent = null;
      state.runtime.consecutiveAbsent = 0;
      state.runtime.consecutivePresent = 0;
      state.runtime.lastDecision = "Sampling paused (monitored tab not active).";
      state.runtime.statusMessage =
        "Monitored tab must be the active tab in its window for screenshot sampling.";
      state.runtime.lastError = null;
      await setStoredState(state);
      await scheduleNextMonitorTick();
      return;
    }

    let dataUrl;

    try {
      dataUrl = await chrome.tabs.captureVisibleTab(state.monitoredWindowId, { format: "png" });
    } catch (error) {
      const message = buildCaptureFailureMessage(error);
      state.runtime.logoPresent = null;
      state.runtime.consecutiveAbsent = 0;
      state.runtime.consecutivePresent = 0;
      state.runtime.lastError = message;
      state.runtime.statusMessage = message;
      state.runtime.lastDecision = "Capture failed; mute state unchanged.";
      await setStoredState(state);
      await scheduleNextMonitorTick();
      return;
    }

    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image")) {
      const message =
        "Capture returned an invalid frame. Use manual mute/hotkey fallback if this continues.";

      state.runtime.logoPresent = null;
      state.runtime.consecutiveAbsent = 0;
      state.runtime.consecutivePresent = 0;
      state.runtime.lastError = message;
      state.runtime.statusMessage = message;
      state.runtime.lastDecision = "Invalid frame; mute state unchanged.";
      await setStoredState(state);
      await scheduleNextMonitorTick();
      return;
    }

    let processed;

    try {
      processed = await processFrameInOffscreen({
        dataUrl,
        roi: state.calibration.roi,
        referenceHash: state.calibration.referenceHash,
        threshold: state.calibration.threshold,
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
    state.runtime.lastDistance = Number.isFinite(Number(processed.distance))
      ? Number(processed.distance)
      : null;

    if (processed.isBlank) {
      const message =
        "Captured frame appears blank/black (likely DRM/protected playback). Auto-detection paused; use manual mute/hotkey fallback.";

      state.runtime.logoPresent = null;
      state.runtime.consecutiveAbsent = 0;
      state.runtime.consecutivePresent = 0;
      state.runtime.lastError = message;
      state.runtime.statusMessage = message;
      state.runtime.lastDecision = "Blank frame detected; mute state unchanged.";
      await setStoredState(state);
      await scheduleNextMonitorTick();
      return;
    }

    state.runtime.lastError = null;
    state.runtime.logoPresent = Boolean(processed.logoPresent);

    if (state.runtime.logoPresent) {
      state.runtime.consecutivePresent += 1;
      state.runtime.consecutiveAbsent = 0;
    } else {
      state.runtime.consecutiveAbsent += 1;
      state.runtime.consecutivePresent = 0;
    }

    const latestTab = await getTabSafe(state.monitoredTabId);

    if (!latestTab) {
      state = await stopMonitoring(state, "Monitored tab became unavailable during detection.");
      state.monitoredTabId = null;
      state.monitoredWindowId = null;
      await setStoredState(state);
      await clearMonitorAlarm();
      return;
    }

    state.runtime.muted = Boolean(latestTab.mutedInfo?.muted);
    state.runtime.mutedReason = latestTab.mutedInfo?.reason ?? null;

    if (state.runtime.logoPresent) {
      if (state.runtime.consecutivePresent >= state.calibration.presentSamplesToUnmute) {
        if (!state.runtime.autoMuted) {
          state.runtime.lastDecision =
            "Logo present but auto-unmute skipped because this extension did not auto-mute the tab.";
        } else if (!state.runtime.muted) {
          state.runtime.autoMuted = false;
          state.runtime.lastDecision = "Logo present and tab is already unmuted.";
        } else if (state.runtime.mutedReason === "user") {
          state.runtime.autoMuted = false;
          state.runtime.lastDecision = "Logo present but user-muted tab respected; no auto-unmute.";
        } else if (state.runtime.mutedReason === "extension") {
          const updated = await chrome.tabs.update(latestTab.id, { muted: false });
          state.runtime.autoMuted = false;
          state.runtime.muted = Boolean(updated.mutedInfo?.muted);
          state.runtime.mutedReason = updated.mutedInfo?.reason ?? null;
          state.runtime.lastDecision =
            "Logo present consistently; tab auto-unmuted by extension.";
        } else {
          state.runtime.autoMuted = false;
          state.runtime.lastDecision =
            "Logo present but mute reason is not extension; no auto-unmute.";
        }
      } else {
        state.runtime.lastDecision = `Logo present (${state.runtime.consecutivePresent}/${state.calibration.presentSamplesToUnmute}).`;
      }
    } else if (state.runtime.consecutiveAbsent >= state.calibration.absentSamplesToMute) {
      if (!state.runtime.muted) {
        const updated = await chrome.tabs.update(latestTab.id, { muted: true });
        state.runtime.autoMuted = true;
        state.runtime.muted = Boolean(updated.mutedInfo?.muted);
        state.runtime.mutedReason = updated.mutedInfo?.reason ?? null;
        state.runtime.lastDecision = "Logo absent consistently; tab auto-muted by extension.";
      } else if (state.runtime.mutedReason === "user") {
        state.runtime.autoMuted = false;
        state.runtime.lastDecision = "Logo absent but tab is already muted by user.";
      } else {
        state.runtime.lastDecision = "Logo absent but tab is already muted.";
      }
    } else {
      state.runtime.lastDecision = `Logo absent (${state.runtime.consecutiveAbsent}/${state.calibration.absentSamplesToMute}).`;
    }

    const logoText = state.runtime.logoPresent ? "present" : "absent";
    const distanceText = Number.isFinite(state.runtime.lastDistance)
      ? `dHash distance ${state.runtime.lastDistance}.`
      : "dHash distance unavailable.";
    state.runtime.statusMessage = `Logo ${logoText}; ${distanceText}`;

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
      const state = await buildPopupState();
      return { state };
    }

    case MESSAGE_TYPES.SET_ENABLED: {
      let state = await getStoredState();
      const enabled = Boolean(message.enabled);

      state.enabled = enabled;

      if (!enabled && state.monitoring) {
        state = await stopMonitoring(state, "Monitoring stopped because extension was disabled.");
      }

      if (enabled && !state.monitoring) {
        state.runtime.statusMessage = "Extension enabled. Start monitoring from the popup.";
        state.runtime.lastDecision = "Extension enabled.";
        state.runtime.lastError = null;
      }

      state = await setStoredState(state);
      return {
        enabled,
        state: await buildPopupState(state),
      };
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

      state.monitoring = true;
      state.monitoredTabId = tab.id;
      state.monitoredWindowId = tab.windowId;
      state.calibrationTarget = {
        tabId: tab.id,
        windowId: tab.windowId,
      };
      state.runtime.logoPresent = null;
      state.runtime.lastDistance = null;
      state.runtime.lastDecision = "Monitoring started for current tab.";
      state.runtime.statusMessage = "Monitoring active. Waiting for next sample.";
      state.runtime.lastError = null;
      state.runtime.autoMuted = false;
      state.runtime.consecutiveAbsent = 0;
      state.runtime.consecutivePresent = 0;
      state.runtime.muted = Boolean(tab.mutedInfo?.muted);
      state.runtime.mutedReason = tab.mutedInfo?.reason ?? null;
      state.runtime.lastCaptureAt = null;

      await clearMonitorAlarm();
      state = await setStoredState(state);
      await scheduleNextMonitorTick(200);

      return {
        state: await buildPopupState(state),
      };
    }

    case MESSAGE_TYPES.STOP_MONITORING: {
      let state = await getStoredState();
      state = await stopMonitoring(state, "Monitoring stopped by user.");
      state = await setStoredState(state);

      return {
        state: await buildPopupState(state),
      };
    }

    case MESSAGE_TYPES.OPEN_OPTIONS: {
      let state = await getStoredState();

      if (Number.isInteger(message.tabId) && Number.isInteger(message.windowId)) {
        state.calibrationTarget = {
          tabId: message.tabId,
          windowId: message.windowId,
        };
      }

      state = await setStoredState(state);
      await chrome.runtime.openOptionsPage();

      return {
        state: await buildPopupState(state),
      };
    }

    case MESSAGE_TYPES.GET_OPTIONS_STATE: {
      const optionsState = await buildOptionsState();
      return { optionsState };
    }

    case MESSAGE_TYPES.CAPTURE_CALIBRATION_FRAME: {
      let state = await getStoredState();
      const resolved = await resolveCalibrationTarget(state);
      state = resolved.state;

      if (!resolved.target) {
        throw new Error(
          "No calibration target tab found. Open options from popup while the stream tab is selected.",
        );
      }

      const capture = await captureVisibleFromTargetTab(resolved.target);

      state.calibrationTarget = {
        tabId: capture.tabId,
        windowId: capture.windowId,
      };
      state.runtime.lastError = null;
      state.runtime.statusMessage = "Calibration frame captured.";
      state.runtime.lastDecision = "Captured frame for calibration.";

      state = await setStoredState(state);

      return {
        capture,
        optionsState: await buildOptionsState(state),
      };
    }

    case MESSAGE_TYPES.SAVE_SETTINGS: {
      let state = await getStoredState();
      const threshold = clampInteger(message.threshold, 0, 64, NaN);
      const absentSamplesToMute = clampInteger(message.absentSamplesToMute, 1, 20, NaN);
      const presentSamplesToUnmute = clampInteger(message.presentSamplesToUnmute, 1, 20, NaN);

      if (!Number.isFinite(threshold)) {
        throw new Error("Threshold must be a number between 0 and 64.");
      }

      if (!Number.isFinite(absentSamplesToMute) || !Number.isFinite(presentSamplesToUnmute)) {
        throw new Error("Hysteresis values must be whole numbers between 1 and 20.");
      }

      state.calibration.threshold = threshold;
      state.calibration.absentSamplesToMute = absentSamplesToMute;
      state.calibration.presentSamplesToUnmute = presentSamplesToUnmute;
      state.runtime.lastError = null;
      state.runtime.statusMessage = "Detection settings saved.";
      state.runtime.lastDecision = "Updated threshold and hysteresis settings.";

      state = await setStoredState(state);

      return {
        optionsState: await buildOptionsState(state),
        state: await buildPopupState(state),
      };
    }

    case MESSAGE_TYPES.SAVE_CALIBRATION: {
      let state = await getStoredState();

      if (!isValidRoi(message.roi)) {
        throw new Error("ROI is invalid. Capture a frame and draw a rectangle before saving.");
      }

      if (typeof message.referenceHash !== "string" || !/^[0-9a-f]{16}$/i.test(message.referenceHash)) {
        throw new Error("Reference hash is invalid.");
      }

      const roi = normalizeRoi(message.roi);

      if (!roi) {
        throw new Error("Failed to normalize ROI values.");
      }

      state.calibration.roi = roi;
      state.calibration.referenceHash = message.referenceHash.toLowerCase();
      state.runtime.lastError = null;
      state.runtime.statusMessage = "Calibration saved. Monitoring can now evaluate logo presence.";
      state.runtime.lastDecision = "Saved calibration ROI and reference hash.";
      state.runtime.logoPresent = null;
      state.runtime.lastDistance = null;
      state.runtime.consecutiveAbsent = 0;
      state.runtime.consecutivePresent = 0;

      state = await setStoredState(state);

      return {
        optionsState: await buildOptionsState(state),
        state: await buildPopupState(state),
      };
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
  let shouldSave = false;

  if (state.calibrationTarget?.tabId === tabId) {
    state.calibrationTarget = null;
    shouldSave = true;
  }

  if (state.monitoredTabId === tabId) {
    state = await stopMonitoring(state, "Monitored tab was closed.");
    state.monitoredTabId = null;
    state.monitoredWindowId = null;
    shouldSave = true;
  }

  if (shouldSave) {
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
