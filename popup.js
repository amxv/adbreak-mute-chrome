const MESSAGE_TYPES = {
  GET_STATE: "GET_STATE",
  SET_ENABLED: "SET_ENABLED",
  MUTE_ACTIVE_TAB: "MUTE_ACTIVE_TAB",
  UNMUTE_ACTIVE_TAB: "UNMUTE_ACTIVE_TAB",
};

const enableToggle = document.getElementById("enable-toggle");
const muteButton = document.getElementById("mute-btn");
const unmuteButton = document.getElementById("unmute-btn");
const statusLine = document.getElementById("status-line");

function setStatus(text) {
  statusLine.textContent = text;
}

function renderState(state) {
  const enabled = Boolean(state?.enabled);
  const hasTab = typeof state?.tabId === "number";
  const muted = Boolean(state?.muted);

  enableToggle.checked = enabled;

  muteButton.disabled = !enabled || !hasTab || muted;
  unmuteButton.disabled = !enabled || !hasTab || !muted;

  if (!hasTab) {
    setStatus(enabled ? "No active tab detected." : "Extension disabled.");
    return;
  }

  if (!enabled) {
    setStatus("Extension disabled.");
    return;
  }

  setStatus(muted ? "Current tab is muted." : "Current tab is unmuted.");
}

async function sendMessage(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });

  if (!response?.ok) {
    throw new Error(response?.error || "Failed to talk to background service worker.");
  }

  return response;
}

async function refreshState() {
  setStatus("Loading status...");

  try {
    const response = await sendMessage(MESSAGE_TYPES.GET_STATE);
    renderState(response.state);
  } catch (error) {
    setStatus(error.message);
  }
}

enableToggle.addEventListener("change", async () => {
  try {
    const response = await sendMessage(MESSAGE_TYPES.SET_ENABLED, {
      enabled: enableToggle.checked,
    });
    renderState(response.state);
  } catch (error) {
    setStatus(error.message);
  }
});

muteButton.addEventListener("click", async () => {
  try {
    const response = await sendMessage(MESSAGE_TYPES.MUTE_ACTIVE_TAB);
    renderState(response.state);
  } catch (error) {
    setStatus(error.message);
  }
});

unmuteButton.addEventListener("click", async () => {
  try {
    const response = await sendMessage(MESSAGE_TYPES.UNMUTE_ACTIVE_TAB);
    renderState(response.state);
  } catch (error) {
    setStatus(error.message);
  }
});

refreshState();
