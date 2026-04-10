const MESSAGE_TYPES = {
  GET_STATE: "GET_STATE",
  SET_ENABLED: "SET_ENABLED",
  START_MONITORING_CURRENT_TAB: "START_MONITORING_CURRENT_TAB",
  STOP_MONITORING: "STOP_MONITORING",
  CAPTURE_IPL_TEMPLATE: "CAPTURE_IPL_TEMPLATE",
  CAPTURE_TEAM_TEMPLATE: "CAPTURE_TEAM_TEMPLATE",
  CLEAR_TEMPLATES: "CLEAR_TEMPLATES",
};

const enableToggle = document.getElementById("enable-toggle");
const captureIplButton = document.getElementById("capture-ipl-btn");
const captureTeamButton = document.getElementById("capture-team-btn");
const clearButton = document.getElementById("clear-btn");
const monitorButton = document.getElementById("monitor-btn");
const templateLine = document.getElementById("template-line");
const monitoredLine = document.getElementById("monitored-line");
const matchLine = document.getElementById("match-line");
const mutedLine = document.getElementById("muted-line");
const decisionLine = document.getElementById("decision-line");
const statusLine = document.getElementById("status-line");

let latestState = null;
let refreshInFlight = false;

function setStatus(text, isError = false) {
  statusLine.textContent = text;
  statusLine.style.color = isError ? "#8f2d1f" : "#1c2431";
}

function truncate(text, maxLength = 38) {
  if (typeof text !== "string") {
    return "";
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1)}…`;
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

function renderTemplateSummary(state) {
  const labels = [];

  if (state?.hasIplTemplate) {
    labels.push("IPL");
  }

  if (state?.hasTeamTemplate) {
    labels.push("Team");
  }

  return labels.length ? labels.join(" + ") : "None saved";
}

function renderMatchSummary(state) {
  const label = state?.matchLabel || "Unknown";
  const score = Number.isFinite(state?.matchScore) ? ` ${state.matchScore.toFixed(2)}` : "";
  return `${label}${score}`;
}

function renderState(state) {
  latestState = state;

  const enabled = Boolean(state?.enabled);
  const hasCurrentTab = Number.isInteger(state?.currentTabId);
  const hasIplTemplate = Boolean(state?.hasIplTemplate);
  const monitoringCurrentTab = Boolean(state?.monitoring && state?.isCurrentTabMonitored);

  enableToggle.checked = enabled;
  captureIplButton.disabled = !enabled || !hasCurrentTab;
  captureTeamButton.disabled = !enabled || !hasCurrentTab;
  clearButton.disabled = !enabled || (!state?.hasIplTemplate && !state?.hasTeamTemplate);
  monitorButton.disabled = !enabled || !hasCurrentTab || !hasIplTemplate;

  monitorButton.textContent = monitoringCurrentTab
    ? "Stop monitoring"
    : state?.monitoring
      ? "Switch to this tab"
      : "Start monitoring";

  templateLine.textContent = renderTemplateSummary(state);
  monitoredLine.textContent = state?.monitoring
    ? truncate(state?.monitoredTabTitle || `Tab ${state?.monitoredTabId || ""}`, 30)
    : "Stopped";
  matchLine.textContent = renderMatchSummary(state);
  mutedLine.textContent = formatMuted(state?.muted, state?.mutedReason);
  decisionLine.textContent = truncate(state?.lastDecision || "Idle.", 46);

  if (state?.lastError) {
    setStatus(state.lastError, true);
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

captureIplButton.addEventListener("click", async () => {
  captureIplButton.disabled = true;
  setStatus("Capturing IPL logo from the current tab...");

  try {
    const response = await sendMessage(MESSAGE_TYPES.CAPTURE_IPL_TEMPLATE);
    renderState(response.state);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    captureIplButton.disabled = false;
  }
});

captureTeamButton.addEventListener("click", async () => {
  captureTeamButton.disabled = true;
  setStatus("Capturing home team logo from the current tab...");

  try {
    const response = await sendMessage(MESSAGE_TYPES.CAPTURE_TEAM_TEMPLATE);
    renderState(response.state);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    captureTeamButton.disabled = false;
  }
});

clearButton.addEventListener("click", async () => {
  try {
    const response = await sendMessage(MESSAGE_TYPES.CLEAR_TEMPLATES);
    renderState(response.state);
  } catch (error) {
    setStatus(error.message, true);
  }
});

monitorButton.addEventListener("click", async () => {
  try {
    const type = latestState?.monitoring && latestState?.isCurrentTabMonitored
      ? MESSAGE_TYPES.STOP_MONITORING
      : MESSAGE_TYPES.START_MONITORING_CURRENT_TAB;
    const response = await sendMessage(type);
    renderState(response.state);
  } catch (error) {
    setStatus(error.message, true);
  }
});

const refreshTimer = setInterval(refreshState, 1000);
window.addEventListener("unload", () => {
  clearInterval(refreshTimer);
});

refreshState();
