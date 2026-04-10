const STORAGE_KEY = "appState";
const debugLog = document.getElementById("debug-log");
const debugState = document.getElementById("debug-state");

function renderState(state) {
  const appState = state?.[STORAGE_KEY] || null;

  if (!appState) {
    debugLog.textContent = "No app state found yet.";
    debugState.textContent = "null";
    return;
  }

  debugLog.textContent = Array.isArray(appState.runtime?.debugLog) && appState.runtime.debugLog.length
    ? appState.runtime.debugLog.join("\n")
    : "No debug events yet.";
  debugState.textContent = JSON.stringify(appState, null, 2);
}

async function refresh() {
  const state = await chrome.storage.local.get(STORAGE_KEY);
  renderState(state);
}

chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName === "local") {
    refresh().catch(() => {
      // Best effort refresh.
    });
  }
});

refresh().catch((error) => {
  debugLog.textContent = error?.message || "Failed to load state.";
});
