const MESSAGE_TYPES = {
  GET_STATE: "GET_STATE",
  SET_ENABLED: "SET_ENABLED",
  START_MONITORING_CURRENT_TAB: "START_MONITORING_CURRENT_TAB",
  STOP_MONITORING: "STOP_MONITORING",
  OPEN_OPTIONS: "OPEN_OPTIONS",
};

const enableToggle = document.getElementById("enable-toggle");
const monitorButton = document.getElementById("monitor-btn");
const optionsButton = document.getElementById("options-btn");
const monitoredLine = document.getElementById("monitored-line");
const logoLine = document.getElementById("logo-line");
const mutedLine = document.getElementById("muted-line");
const decisionLine = document.getElementById("decision-line");
const statusLine = document.getElementById("status-line");

let latestState = null;
let refreshInFlight = false;

function setStatus(text, isError = false) {
  statusLine.textContent = text;
  statusLine.style.color = isError ? "#b91c1c" : "#1f2937";
}

function formatLogo(logoPresent) {
  if (logoPresent === true) {
    return "Present";
  }

  if (logoPresent === false) {
    return "Absent";
  }

  return "Unknown";
}

function formatMuted(muted, mutedReason) {
  if (muted === true) {
    return mutedReason ? `Muted (${mutedReason})` : "Muted";
  }

  if (muted === false) {
    return "Unmuted";
  }

  return "Unknown";
}

function truncate(text, maxLength = 34) {
  if (typeof text !== "string") {
    return "";
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1)}…`;
}

function renderState(state) {
  latestState = state;

  const enabled = Boolean(state?.enabled);
  const hasCurrentTab = Number.isInteger(state?.currentTabId);
  const monitoring = Boolean(state?.monitoring);
  const currentTabMonitored = Boolean(state?.isCurrentTabMonitored);

  enableToggle.checked = enabled;
  monitorButton.disabled = !enabled || !hasCurrentTab;
  optionsButton.disabled = !hasCurrentTab;

  if (!enabled) {
    monitorButton.textContent = "Enable extension to monitor";
  } else if (monitoring && currentTabMonitored) {
    monitorButton.textContent = "Stop monitoring current tab";
  } else if (monitoring && state?.monitoredTabId) {
    monitorButton.textContent = "Switch monitoring to current tab";
  } else {
    monitorButton.textContent = "Start monitoring current tab";
  }

  const monitoredTabLabel = state?.monitoredTabTitle
    ? truncate(state.monitoredTabTitle)
    : Number.isInteger(state?.monitoredTabId)
      ? `Tab ${state.monitoredTabId}`
      : "None";

  monitoredLine.textContent = monitoring ? monitoredTabLabel : "Stopped";
  logoLine.textContent = formatLogo(state?.logoPresent);
  mutedLine.textContent = formatMuted(state?.muted, state?.mutedReason);
  decisionLine.textContent = truncate(state?.lastDecision || "Idle", 42);

  if (state?.lastError) {
    setStatus(state.lastError, true);
    return;
  }

  if (!state?.calibrationReady) {
    setStatus("Calibration missing. Open calibration/options and save an ROI + reference hash.");
    return;
  }

  setStatus(state?.statusMessage || "Ready.");
}

async function sendMessage(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });

  if (!response?.ok) {
    throw new Error(response?.error || "Request failed.");
  }

  return response;
}

async function refreshState() {
  if (refreshInFlight) {
    return;
  }

  refreshInFlight = true;

  try {
    const response = await sendMessage(MESSAGE_TYPES.GET_STATE);
    renderState(response.state);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    refreshInFlight = false;
  }
}

enableToggle.addEventListener("change", async () => {
  try {
    const response = await sendMessage(MESSAGE_TYPES.SET_ENABLED, {
      enabled: enableToggle.checked,
    });
    renderState(response.state);
  } catch (error) {
    setStatus(error.message, true);
  }
});

monitorButton.addEventListener("click", async () => {
  try {
    const shouldStop = Boolean(latestState?.monitoring && latestState?.isCurrentTabMonitored);
    const type = shouldStop
      ? MESSAGE_TYPES.STOP_MONITORING
      : MESSAGE_TYPES.START_MONITORING_CURRENT_TAB;

    const response = await sendMessage(type);
    renderState(response.state);
  } catch (error) {
    setStatus(error.message, true);
  }
});

optionsButton.addEventListener("click", async () => {
  try {
    await sendMessage(MESSAGE_TYPES.OPEN_OPTIONS, {
      tabId: latestState?.currentTabId,
      windowId: latestState?.currentWindowId,
    });
  } catch (error) {
    setStatus(error.message, true);
  }
});

const refreshTimer = setInterval(refreshState, 1000);
window.addEventListener("unload", () => {
  clearInterval(refreshTimer);
});

refreshState();
