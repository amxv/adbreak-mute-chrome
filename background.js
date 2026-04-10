const MESSAGE_TYPES = {
  GET_STATE: "GET_STATE",
  SET_ENABLED: "SET_ENABLED",
  START_MONITORING_CURRENT_TAB: "START_MONITORING_CURRENT_TAB",
  STOP_MONITORING: "STOP_MONITORING",
  CAPTURE_IPL_TEMPLATE: "CAPTURE_IPL_TEMPLATE",
  CAPTURE_TEAM_TEMPLATE: "CAPTURE_TEAM_TEMPLATE",
  CLEAR_TEMPLATES: "CLEAR_TEMPLATES",
};

const STORAGE_KEY = "appState";
const MONITOR_ALARM = "monitor-sample";
const SAMPLE_INTERVAL_MS = 700;
const SEARCH_REGION = {
  x: 0.02,
  y: 0.02,
  w: 0.32,
  h: 0.22,
};
const SEGMENT_DEFS = [
  { name: "full", x: 0.02, y: 0.08, w: 0.72, h: 0.82 },
  { name: "body", x: 0.12, y: 0.26, w: 0.55, h: 0.64 },
  { name: "lower", x: 0.08, y: 0.44, w: 0.62, h: 0.46 },
];
const MATCH_THRESHOLD = 0.52;
const SOFT_MATCH_THRESHOLD = 0.4;
const ABSENT_SAMPLES_TO_MUTE = 3;
const PRESENT_SAMPLES_TO_UNMUTE = 1;
const DEBUG_MIRROR_URL = "http://127.0.0.1:38241/log";

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
    debugLog: [],
    consecutivePresent: 0,
    consecutiveAbsent: 0,
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
      debugLog: Array.isArray(runtime.debugLog)
        ? runtime.debugLog.filter((entry) => typeof entry === "string").slice(0, 12)
        : DEFAULT_STATE.runtime.debugLog,
      consecutivePresent: Number.isInteger(runtime.consecutivePresent) && runtime.consecutivePresent >= 0
        ? runtime.consecutivePresent
        : 0,
      consecutiveAbsent: Number.isInteger(runtime.consecutiveAbsent) && runtime.consecutiveAbsent >= 0
        ? runtime.consecutiveAbsent
        : 0,
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
  const lastFocusedTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  if (lastFocusedTabs[0]) {
    return lastFocusedTabs[0];
  }

  const currentWindowTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return currentWindowTabs[0] || null;
}

function buildCaptureFailureMessage(error) {
  const reason = error?.message || "Unknown capture error.";
  return `Frame capture failed (${reason}). Some streams block screenshots or return blank frames.`;
}

function appendDebug(state, message) {
  const next = withDefaults(state);
  const stamp = new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const line = `${stamp} ${message}`;
  next.runtime.debugLog = [line, ...next.runtime.debugLog].slice(0, 12);
  mirrorDebugLine(line);
  return next;
}

function mirrorDebugLine(line) {
  fetch(DEBUG_MIRROR_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ts: Date.now(),
      line,
    }),
  }).catch(() => {
    // Local debug mirror is optional; keep extension behavior unaffected if unavailable.
  });
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

function normalizeRegionPixels(region, width, height) {
  const x = Math.min(0.99, Math.max(0, Number(region.x)));
  const y = Math.min(0.99, Math.max(0, Number(region.y)));
  const w = Math.min(1 - x, Math.max(0.01, Number(region.w)));
  const h = Math.min(1 - y, Math.max(0.01, Number(region.h)));

  const px = Math.max(0, Math.min(width - 1, Math.floor(x * width)));
  const py = Math.max(0, Math.min(height - 1, Math.floor(y * height)));
  const pw = Math.max(8, Math.min(width - px, Math.ceil(w * width)));
  const ph = Math.max(8, Math.min(height - py, Math.ceil(h * height)));

  return { x: px, y: py, w: pw, h: ph };
}

function detectBlankFrame(imageData) {
  const { data } = imageData;

  if (!data.length) {
    return { isBlank: true };
  }

  let sum = 0;
  let sumSq = 0;
  let maxLuma = 0;
  let nearBlack = 0;

  for (let i = 0; i < data.length; i += 4) {
    const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += luma;
    sumSq += luma * luma;
    if (luma > maxLuma) {
      maxLuma = luma;
    }
    if (luma < 12) {
      nearBlack += 1;
    }
  }

  const pixelCount = data.length / 4;
  const meanLuma = sum / pixelCount;
  const variance = Math.max(0, sumSq / pixelCount - meanLuma * meanLuma);
  const stdDev = Math.sqrt(variance);
  const nearBlackRatio = nearBlack / pixelCount;

  return {
    isBlank: nearBlackRatio > 0.98 && maxLuma < 24 && stdDev < 6,
  };
}

async function loadImageBitmapFromDataUrl(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image")) {
    throw new Error("Invalid image payload.");
  }

  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return createImageBitmap(blob);
}

function createCanvas(width, height) {
  return new OffscreenCanvas(width, height);
}

function toGrayscaleEdges(imageData) {
  const { data, width, height } = imageData;
  const gray = new Array(width * height).fill(0);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      gray[y * width + x] = 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
    }
  }

  const edges = new Array(width * height).fill(0);

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const left = gray[y * width + (x - 1)];
      const right = gray[y * width + (x + 1)];
      const up = gray[(y - 1) * width + x];
      const down = gray[(y + 1) * width + x];
      const dx = right - left;
      const dy = down - up;
      edges[y * width + x] = Math.min(255, Math.sqrt(dx * dx + dy * dy));
    }
  }

  const max = edges.reduce((current, value) => Math.max(current, value), 0) || 1;
  return edges.map((value) => Number((value / max).toFixed(4)));
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const lightness = (max + min) / 2;

  if (max === min) {
    return { saturation: 0, lightness };
  }

  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  return { saturation, lightness };
}

function computeSegmentStats(imageData) {
  const { data } = imageData;
  const pixelCount = data.length / 4 || 1;
  let whitePixels = 0;
  let colorPixels = 0;
  let edgeSourcePixels = 0;

  for (let offset = 0; offset < data.length; offset += 4) {
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    const maxChannel = Math.max(r, g, b);
    const minChannel = Math.min(r, g, b);
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const { saturation } = rgbToHsl(r, g, b);

    if (luma > 170 && saturation < 0.25 && maxChannel - minChannel < 55) {
      whitePixels += 1;
    }

    if (saturation > 0.28 && luma > 35 && luma < 220) {
      colorPixels += 1;
    }

    if (luma > 145 || saturation > 0.25) {
      edgeSourcePixels += 1;
    }
  }

  return {
    whiteRatio: Number((whitePixels / pixelCount).toFixed(4)),
    colorRatio: Number((colorPixels / pixelCount).toFixed(4)),
    edgeSourceRatio: Number((edgeSourcePixels / pixelCount).toFixed(4)),
  };
}

function extractSegment(sourceCanvas, region, segmentDef, width = 32, height = 32) {
  const segmentCanvas = createCanvas(width, height);
  const segmentContext = segmentCanvas.getContext("2d", { willReadFrequently: true });

  const sx = region.x + Math.floor(region.w * segmentDef.x);
  const sy = region.y + Math.floor(region.h * segmentDef.y);
  const sw = Math.max(4, Math.floor(region.w * segmentDef.w));
  const sh = Math.max(4, Math.floor(region.h * segmentDef.h));

  segmentContext.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, width, height);
  return segmentContext.getImageData(0, 0, width, height);
}

function compareArrays(a, b) {
  const length = Math.min(a.length, b.length);

  if (!length) {
    return 1;
  }

  let totalDiff = 0;
  let totalEnergy = 0;

  for (let index = 0; index < length; index += 1) {
    totalDiff += Math.abs(a[index] - b[index]);
    totalEnergy += Math.max(a[index], b[index]);
  }

  if (totalEnergy < 0.0001) {
    return 1;
  }

  return 1 - totalDiff / totalEnergy;
}

function buildTemplateSegments(sourceCanvas, region) {
  return SEGMENT_DEFS.map((segmentDef) => {
    const imageData = extractSegment(sourceCanvas, region, segmentDef);
    const stats = computeSegmentStats(imageData);
    return {
      name: segmentDef.name,
      width: imageData.width,
      height: imageData.height,
      data: toGrayscaleEdges(imageData),
      whiteRatio: stats.whiteRatio,
      colorRatio: stats.colorRatio,
      edgeSourceRatio: stats.edgeSourceRatio,
    };
  });
}

function summarizeTemplateProfile(segments) {
  const whiteAverage = segments.reduce((sum, segment) => sum + segment.whiteRatio, 0) / segments.length;
  const colorAverage = segments.reduce((sum, segment) => sum + segment.colorRatio, 0) / segments.length;

  return {
    dominantInk: whiteAverage >= colorAverage ? "white" : "color",
    whiteAverage: Number(whiteAverage.toFixed(4)),
    colorAverage: Number(colorAverage.toFixed(4)),
  };
}

async function buildTemplateFromDataUrl({ dataUrl, label }) {
  const image = await loadImageBitmapFromDataUrl(dataUrl);
  const width = image.width;
  const height = image.height;

  if (!width || !height) {
    throw new Error("Captured frame has invalid dimensions.");
  }

  const sourceCanvas = createCanvas(width, height);
  const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
  sourceContext.drawImage(image, 0, 0, width, height);

  const region = normalizeRegionPixels(SEARCH_REGION, width, height);
  const regionImageData = sourceContext.getImageData(region.x, region.y, region.w, region.h);
  const blank = detectBlankFrame(regionImageData);

  if (blank.isBlank) {
    throw new Error("The captured top-left region looks blank. Try again while the stream is visible.");
  }

  const segments = buildTemplateSegments(sourceCanvas, region);

  return {
    label,
    region: SEARCH_REGION,
    segments,
    profile: summarizeTemplateProfile(segments),
  };
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function scoreRatio(currentValue, templateValue) {
  const baseline = Math.max(templateValue, 0.02);
  return clamp01(1 - Math.abs(currentValue - templateValue) / baseline);
}

async function matchFrameAgainstTemplates({ dataUrl, templates }) {
  if (!Array.isArray(templates) || !templates.length) {
    throw new Error("No templates provided.");
  }

  const image = await loadImageBitmapFromDataUrl(dataUrl);
  const width = image.width;
  const height = image.height;

  if (!width || !height) {
    throw new Error("Captured frame has invalid dimensions.");
  }

  const sourceCanvas = createCanvas(width, height);
  const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
  sourceContext.drawImage(image, 0, 0, width, height);

  const region = normalizeRegionPixels(SEARCH_REGION, width, height);
  const regionImageData = sourceContext.getImageData(region.x, region.y, region.w, region.h);
  const blank = detectBlankFrame(regionImageData);

  if (blank.isBlank) {
    return {
      isBlank: true,
      logoPresent: false,
      matchLabel: "Unknown",
      matchScore: 0,
    };
  }

  const currentSegments = buildTemplateSegments(sourceCanvas, region);
  let bestTemplate = null;
  let bestScore = -Infinity;
  let bestInkScore = 0;
  let bestCurrentInk = 0;
  let bestTemplateInk = 0;

  for (const template of templates) {
    let scoreSum = 0;
    let count = 0;
    let currentInkAverage = 0;
    let templateInkAverage = 0;
    let inkScoreSum = 0;

    for (const templateSegment of template.segments) {
      const currentSegment = currentSegments.find((segment) => segment.name === templateSegment.name);

      if (!currentSegment) {
        continue;
      }

      const edgeScore = compareArrays(currentSegment.data, templateSegment.data);
      const useWhiteInk = (template.profile?.dominantInk || "white") === "white";
      const currentInkRatio = useWhiteInk ? currentSegment.whiteRatio : currentSegment.colorRatio;
      const templateInkRatio = useWhiteInk ? templateSegment.whiteRatio : templateSegment.colorRatio;
      const inkScore = scoreRatio(currentInkRatio, templateInkRatio);
      const edgeSourceScore = scoreRatio(currentSegment.edgeSourceRatio, templateSegment.edgeSourceRatio);
      const segmentScore = inkScore * 0.6 + edgeScore * 0.25 + edgeSourceScore * 0.15;

      scoreSum += segmentScore;
      inkScoreSum += inkScore;
      currentInkAverage += currentInkRatio;
      templateInkAverage += templateInkRatio;
      count += 1;
    }

    const rawScore = count ? scoreSum / count : 0;
    const avgInkScore = count ? inkScoreSum / count : 0;
    const avgCurrentInk = count ? currentInkAverage / count : 0;
    const avgTemplateInk = count ? templateInkAverage / count : 0;
    const inkPresenceFloor = avgTemplateInk > 0.03 ? avgTemplateInk * 0.35 : 0.015;
    const score = avgCurrentInk < inkPresenceFloor ? rawScore * 0.35 : rawScore;

    if (score > bestScore) {
      bestScore = score;
      bestTemplate = template;
      bestInkScore = avgInkScore;
      bestCurrentInk = avgCurrentInk;
      bestTemplateInk = avgTemplateInk;
    }
  }

  const inkPresenceThreshold = Math.max(bestTemplateInk * 0.42, 0.018);
  const likelyStaticLogoInk = bestCurrentInk >= inkPresenceThreshold && bestInkScore >= 0.58;
  const logoPresent = bestScore >= MATCH_THRESHOLD || (bestScore >= SOFT_MATCH_THRESHOLD && likelyStaticLogoInk);

  return {
    isBlank: false,
    logoPresent,
    matchLabel: bestTemplate?.label || "Unknown",
    matchScore: bestScore,
    inkScore: bestInkScore,
    currentInk: bestCurrentInk,
    templateInk: bestTemplateInk,
    likelyStaticLogoInk,
  };
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
  next.runtime.consecutivePresent = 0;
  next.runtime.consecutiveAbsent = 0;
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
    debugLog: state.runtime.debugLog,
    consecutivePresent: state.runtime.consecutivePresent,
    consecutiveAbsent: state.runtime.consecutiveAbsent,
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

  let state = await getStoredState();
  state = appendDebug(
    state,
    `Capture requested for ${kind === "ipl" ? "IPL" : "team"} logo from tab ${activeTab.id} (${activeTab.title || "untitled"}).`,
  );
  await setStoredState(state);

  const capture = await captureVisibleFromTab(activeTab);
  state = await getStoredState();
  state = appendDebug(
    state,
    `Screenshot captured from tab ${capture.tabId} in window ${capture.windowId}.`,
  );
  await setStoredState(state);

  state = appendDebug(
    state,
    `Sending screenshot to offscreen processor for ${kind === "ipl" ? "IPL" : "team"} template build.`,
  );
  await setStoredState(state);

  let template;

  try {
    template = {
      template: await buildTemplateFromDataUrl({
        dataUrl: capture.dataUrl,
        label: kind === "ipl" ? "IPL logo" : "Home team logo",
      }),
    };
  } catch (error) {
    state = await getStoredState();
      state.runtime.lastError = error?.message || "Offscreen template build failed.";
      state.runtime.statusMessage = state.runtime.lastError;
      state.runtime.lastDecision = "Capture failed before template save.";
    state = appendDebug(state, `Template build failed: ${state.runtime.lastError}`);
    await setStoredState(state);
    throw error;
  }

  state = await getStoredState();
  state.monitoredTabId = capture.tabId;
  state.monitoredWindowId = capture.windowId;
  state.templates[kind] = template.template;
  state.runtime.lastError = null;
  state.runtime.lastDecision = `${template.template.label} captured from current tab.`;
  state.runtime.statusMessage = `${template.template.label} saved. ${
    state.templates.ipl ? "You can start monitoring." : "Capture the IPL logo first."
  }`;
  state = appendDebug(
    state,
    `${template.template.label} saved with ${template.template.segments.length} matching segments.`,
  );
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
      state = appendDebug(state, "Monitoring blocked because no IPL template is saved.");
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
      state.runtime.consecutivePresent = 0;
      state.runtime.consecutiveAbsent = 0;
      state = appendDebug(state, message);
      await setStoredState(state);
      await scheduleNextMonitorTick();
      return;
    }

    const templates = [state.templates.ipl, state.templates.team].filter(Boolean);

    let matchResult;

    try {
      state = appendDebug(state, "Processing monitor sample in service worker matcher.");
      await setStoredState(state);
      matchResult = await matchFrameAgainstTemplates({
        dataUrl,
        templates,
      });
    } catch (error) {
      const message = `Image processing failed (${error?.message || "unknown"}).`;
      state.runtime.lastError = message;
      state.runtime.statusMessage = message;
      state.runtime.lastDecision = "Frame processing failed; mute state unchanged.";
      state.runtime.consecutivePresent = 0;
      state.runtime.consecutiveAbsent = 0;
      state = appendDebug(state, message);
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
      state.runtime.consecutivePresent = 0;
      state.runtime.consecutiveAbsent = 0;
      state = appendDebug(state, message);
      await setStoredState(state);
      await scheduleNextMonitorTick();
      return;
    }

    state.runtime.lastError = null;

    if (matchResult.logoPresent) {
      state.runtime.consecutivePresent += 1;
      state.runtime.consecutiveAbsent = 0;

      if (
        state.runtime.consecutivePresent >= PRESENT_SAMPLES_TO_UNMUTE &&
        state.runtime.autoMuted &&
        state.runtime.muted &&
        state.runtime.mutedReason === "extension"
      ) {
        const updated = await chrome.tabs.update(monitoredTab.id, { muted: false });
        state.runtime.autoMuted = false;
        state.runtime.muted = Boolean(updated.mutedInfo?.muted);
        state.runtime.mutedReason = updated.mutedInfo?.reason ?? null;
        state.runtime.lastDecision = `${matchResult.matchLabel} detected consistently; tab auto-unmuted.`;
      } else {
        state.runtime.lastDecision = `${matchResult.matchLabel} detected (${state.runtime.consecutivePresent}/${PRESENT_SAMPLES_TO_UNMUTE}); tab kept unmuted.`;
      }
    } else {
      state.runtime.consecutiveAbsent += 1;
      state.runtime.consecutivePresent = 0;

      if (state.runtime.consecutiveAbsent >= ABSENT_SAMPLES_TO_MUTE && !state.runtime.muted) {
        const updated = await chrome.tabs.update(monitoredTab.id, { muted: true });
        state.runtime.autoMuted = true;
        state.runtime.muted = Boolean(updated.mutedInfo?.muted);
        state.runtime.mutedReason = updated.mutedInfo?.reason ?? null;
        state.runtime.lastDecision = "No saved logo detected consistently; tab auto-muted.";
      } else if (state.runtime.mutedReason === "user") {
        state.runtime.autoMuted = false;
        state.runtime.lastDecision = "No saved logo detected; tab already muted by user.";
      } else {
        state.runtime.lastDecision = `No saved logo detected (${state.runtime.consecutiveAbsent}/${ABSENT_SAMPLES_TO_MUTE}); mute unchanged.`;
      }
    }

    const scoreText = Number.isFinite(state.runtime.matchScore)
      ? `match score ${state.runtime.matchScore.toFixed(3)}`
      : "match score unavailable";
    const inkText =
      Number.isFinite(matchResult.inkScore) &&
      Number.isFinite(matchResult.currentInk) &&
      Number.isFinite(matchResult.templateInk)
        ? `ink ${matchResult.inkScore.toFixed(3)} (${matchResult.currentInk.toFixed(3)}/${matchResult.templateInk.toFixed(3)})`
        : "ink unavailable";
    state.runtime.statusMessage = matchResult.logoPresent
      ? `${matchResult.matchLabel} found in top-left region; ${scoreText}; ${inkText}.`
      : `No saved logo found in top-left region; ${scoreText}; ${inkText}.`;
    state = appendDebug(
      state,
      `Monitor sample result: ${matchResult.logoPresent ? "match" : "no match"} (${matchResult.matchLabel}, ${scoreText}, ${inkText}, static-ink ${matchResult.likelyStaticLogoInk ? "yes" : "no"}).`,
    );

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

      state = appendDebug(state, `Extension ${state.enabled ? "enabled" : "disabled"}.`);
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
      state.runtime.consecutivePresent = 0;
      state.runtime.consecutiveAbsent = 0;
      state.runtime.lastDecision = "Saved logos cleared.";
      state.runtime.statusMessage = "Capture the IPL logo again before monitoring.";
      state = appendDebug(state, "Saved templates cleared.");

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
      state.runtime.consecutivePresent = 0;
      state.runtime.consecutiveAbsent = 0;
      state.runtime.lastDecision = "Monitoring started for current tab.";
      state.runtime.statusMessage = "Monitoring active. Waiting for the next sample.";
      state.runtime.autoMuted = false;
      state.runtime.muted = Boolean(tab.mutedInfo?.muted);
      state.runtime.mutedReason = tab.mutedInfo?.reason ?? null;
      state.runtime.lastCaptureAt = null;
      state = appendDebug(
        state,
        `Monitoring started on tab ${tab.id} (${tab.title || "untitled"}).`,
      );

      await clearMonitorAlarm();
      state = await setStoredState(state);
      await scheduleNextMonitorTick(250);

      return { state: await buildPopupState(state) };
    }

    case MESSAGE_TYPES.STOP_MONITORING: {
      let state = await getStoredState();
      state = await stopMonitoring(state, "Monitoring stopped by user.");
      state = appendDebug(state, "Monitoring stopped by user.");
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
    let state = await getStoredState();
    state.runtime.lastError = `Monitoring failure: ${error?.message || "Unknown error."}`;
    state.runtime.statusMessage = state.runtime.lastError;
    state.runtime.lastDecision = "Monitoring encountered an error.";
    state = appendDebug(state, state.runtime.lastError);
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
