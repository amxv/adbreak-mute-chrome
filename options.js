const MESSAGE_TYPES = {
  GET_OPTIONS_STATE: "GET_OPTIONS_STATE",
  CAPTURE_CALIBRATION_FRAME: "CAPTURE_CALIBRATION_FRAME",
  SAVE_SETTINGS: "SAVE_SETTINGS",
  SAVE_CALIBRATION: "SAVE_CALIBRATION",
};

const NIBBLE_BIT_COUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

const targetLine = document.getElementById("target-line");
const captureButton = document.getElementById("capture-btn");
const saveCalibrationButton = document.getElementById("save-calibration-btn");
const saveSettingsButton = document.getElementById("save-settings-btn");
const thresholdInput = document.getElementById("threshold-input");
const absentInput = document.getElementById("absent-input");
const presentInput = document.getElementById("present-input");
const statusLine = document.getElementById("status-line");
const roiLine = document.getElementById("roi-line");
const canvas = document.getElementById("frame-canvas");
const context = canvas.getContext("2d", { willReadFrequently: true });

let optionsState = null;
let frameImage = null;
let selection = null;
let dragging = false;
let dragStart = null;

function setStatus(text, isError = false) {
  statusLine.textContent = text;
  statusLine.style.color = isError ? "#b91c1c" : "#111827";
}

function formatTabText(tab) {
  if (!tab) {
    return "Target tab: Not selected. Open this page from popup while your stream tab is active.";
  }

  const label = tab.title || tab.url || `Tab ${tab.id}`;
  return `Target tab: ${label} (id ${tab.id})`;
}

async function sendMessage(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });

  if (!response?.ok) {
    throw new Error(response?.error || "Background request failed.");
  }

  return response;
}

function normalizeRoiPixels(roi, width, height) {
  const x = Math.min(0.99, Math.max(0, Number(roi.x)));
  const y = Math.min(0.99, Math.max(0, Number(roi.y)));
  const w = Math.min(1 - x, Math.max(0.005, Number(roi.w)));
  const h = Math.min(1 - y, Math.max(0.005, Number(roi.h)));

  const px = Math.max(0, Math.min(width - 1, Math.floor(x * width)));
  const py = Math.max(0, Math.min(height - 1, Math.floor(y * height)));
  const pw = Math.max(2, Math.min(width - px, Math.ceil(w * width)));
  const ph = Math.max(2, Math.min(height - py, Math.ceil(h * height)));

  return { x: px, y: py, w: pw, h: ph };
}

function computeDHashFromImageData(imageData) {
  const { data, width, height } = imageData;

  if (width !== 9 || height !== 8) {
    throw new Error("dHash input must be 9x8.");
  }

  const grayscale = new Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      grayscale[y * width + x] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }

  const bits = [];

  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = grayscale[y * 9 + x];
      const right = grayscale[y * 9 + x + 1];
      bits.push(left > right ? 1 : 0);
    }
  }

  let hex = "";

  for (let i = 0; i < bits.length; i += 4) {
    const value = (bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3];
    hex += value.toString(16);
  }

  return hex;
}

function hammingDistanceHex(hashA, hashB) {
  if (hashA.length !== hashB.length) {
    throw new Error("Hash lengths differ.");
  }

  let distance = 0;

  for (let i = 0; i < hashA.length; i += 1) {
    const xorValue = parseInt(hashA[i], 16) ^ parseInt(hashB[i], 16);
    distance += NIBBLE_BIT_COUNT[xorValue];
  }

  return distance;
}

function hasSelection() {
  return Boolean(selection && selection.w >= 4 && selection.h >= 4);
}

function normalizedRoiFromSelection() {
  if (!hasSelection()) {
    return null;
  }

  const x = selection.x / canvas.width;
  const y = selection.y / canvas.height;
  const w = selection.w / canvas.width;
  const h = selection.h / canvas.height;

  return {
    x: Number(Math.max(0, Math.min(0.99, x)).toFixed(6)),
    y: Number(Math.max(0, Math.min(0.99, y)).toFixed(6)),
    w: Number(Math.max(0.005, Math.min(1 - x, w)).toFixed(6)),
    h: Number(Math.max(0.005, Math.min(1 - y, h)).toFixed(6)),
  };
}

function selectionFromNormalizedRoi(roi) {
  if (!roi) {
    return null;
  }

  return {
    x: Math.round(roi.x * canvas.width),
    y: Math.round(roi.y * canvas.height),
    w: Math.max(2, Math.round(roi.w * canvas.width)),
    h: Math.max(2, Math.round(roi.h * canvas.height)),
  };
}

function updateRoiLine() {
  const roi = normalizedRoiFromSelection();

  if (roi) {
    roiLine.textContent = `ROI selected: x ${Math.round(roi.x * 100)}%, y ${Math.round(
      roi.y * 100,
    )}%, w ${Math.round(roi.w * 100)}%, h ${Math.round(roi.h * 100)}%.`;
    return;
  }

  if (optionsState?.calibration?.roi) {
    const saved = optionsState.calibration.roi;
    roiLine.textContent = `Saved ROI: x ${Math.round(saved.x * 100)}%, y ${Math.round(
      saved.y * 100,
    )}%, w ${Math.round(saved.w * 100)}%, h ${Math.round(saved.h * 100)}%.`;
    return;
  }

  roiLine.textContent = "No ROI selected yet.";
}

function drawCanvas() {
  context.clearRect(0, 0, canvas.width, canvas.height);

  if (!frameImage) {
    context.fillStyle = "#f3f4f6";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#6b7280";
    context.font = "14px sans-serif";
    context.fillText("Capture a frame to begin ROI selection.", 18, 28);
    saveCalibrationButton.disabled = true;
    updateRoiLine();
    return;
  }

  context.drawImage(frameImage, 0, 0, canvas.width, canvas.height);

  if (hasSelection()) {
    context.save();
    context.strokeStyle = "#dc2626";
    context.lineWidth = 2;
    context.fillStyle = "rgba(220, 38, 38, 0.15)";
    context.fillRect(selection.x, selection.y, selection.w, selection.h);
    context.strokeRect(selection.x, selection.y, selection.w, selection.h);
    context.restore();
  }

  saveCalibrationButton.disabled = !hasSelection();
  updateRoiLine();
}

function rectFromPoints(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x);
  const h = Math.abs(a.y - b.y);

  return {
    x: Math.max(0, Math.min(canvas.width - 1, x)),
    y: Math.max(0, Math.min(canvas.height - 1, y)),
    w: Math.max(1, Math.min(canvas.width, w)),
    h: Math.max(1, Math.min(canvas.height, h)),
  };
}

function pointFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  return {
    x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * scaleX)),
    y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * scaleY)),
  };
}

async function loadFrameFromDataUrl(dataUrl) {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();

  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const maxWidth = 920;
  const maxHeight = 540;
  const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);

  canvas.width = Math.max(2, Math.round(sourceWidth * scale));
  canvas.height = Math.max(2, Math.round(sourceHeight * scale));
  frameImage = image;

  selection = optionsState?.calibration?.roi
    ? selectionFromNormalizedRoi(optionsState.calibration.roi)
    : null;

  drawCanvas();
}

function computeHashFromSelection() {
  if (!frameImage) {
    throw new Error("Capture a frame first.");
  }

  const roi = normalizedRoiFromSelection();

  if (!roi) {
    throw new Error("Select an ROI first.");
  }

  const imageWidth = frameImage.naturalWidth || frameImage.width;
  const imageHeight = frameImage.naturalHeight || frameImage.height;

  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = imageWidth;
  sourceCanvas.height = imageHeight;
  const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
  sourceContext.drawImage(frameImage, 0, 0, imageWidth, imageHeight);

  const roiPixels = normalizeRoiPixels(roi, imageWidth, imageHeight);

  const hashCanvas = document.createElement("canvas");
  hashCanvas.width = 9;
  hashCanvas.height = 8;
  const hashContext = hashCanvas.getContext("2d", { willReadFrequently: true });

  hashContext.drawImage(
    sourceCanvas,
    roiPixels.x,
    roiPixels.y,
    roiPixels.w,
    roiPixels.h,
    0,
    0,
    9,
    8,
  );

  const hashImageData = hashContext.getImageData(0, 0, 9, 8);
  return {
    roi,
    hash: computeDHashFromImageData(hashImageData),
  };
}

function applyOptionsState(nextOptionsState) {
  optionsState = nextOptionsState;
  targetLine.textContent = formatTabText(optionsState?.targetTab || null);

  const calibration = optionsState?.calibration || {};
  thresholdInput.value = calibration.threshold ?? 10;
  absentInput.value = calibration.absentSamplesToMute ?? 3;
  presentInput.value = calibration.presentSamplesToUnmute ?? 2;

  if (!frameImage && calibration.roi) {
    selection = null;
  }

  updateRoiLine();
}

async function refreshOptionsState() {
  const response = await sendMessage(MESSAGE_TYPES.GET_OPTIONS_STATE);
  applyOptionsState(response.optionsState);
  drawCanvas();
}

canvas.addEventListener("mousedown", (event) => {
  if (!frameImage) {
    return;
  }

  dragging = true;
  dragStart = pointFromEvent(event);
  selection = { ...dragStart, w: 1, h: 1 };
  drawCanvas();
});

canvas.addEventListener("mousemove", (event) => {
  if (!dragging || !dragStart) {
    return;
  }

  const current = pointFromEvent(event);
  selection = rectFromPoints(dragStart, current);
  drawCanvas();
});

canvas.addEventListener("mouseup", (event) => {
  if (!dragging || !dragStart) {
    return;
  }

  const current = pointFromEvent(event);
  selection = rectFromPoints(dragStart, current);
  dragging = false;
  dragStart = null;
  drawCanvas();
});

canvas.addEventListener("mouseleave", () => {
  if (!dragging) {
    return;
  }

  dragging = false;
  dragStart = null;
  drawCanvas();
});

captureButton.addEventListener("click", async () => {
  captureButton.disabled = true;
  setStatus("Capturing frame from target tab...");

  try {
    const response = await sendMessage(MESSAGE_TYPES.CAPTURE_CALIBRATION_FRAME);
    applyOptionsState(response.optionsState);
    await loadFrameFromDataUrl(response.capture.dataUrl);
    setStatus("Frame captured. Drag a rectangle over the logo area, then save ROI.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    captureButton.disabled = false;
  }
});

saveSettingsButton.addEventListener("click", async () => {
  saveSettingsButton.disabled = true;
  setStatus("Saving detection settings...");

  try {
    const response = await sendMessage(MESSAGE_TYPES.SAVE_SETTINGS, {
      threshold: Number(thresholdInput.value),
      absentSamplesToMute: Number(absentInput.value),
      presentSamplesToUnmute: Number(presentInput.value),
    });

    applyOptionsState(response.optionsState);
    setStatus("Settings saved.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    saveSettingsButton.disabled = false;
  }
});

saveCalibrationButton.addEventListener("click", async () => {
  if (!hasSelection()) {
    setStatus("Select a non-trivial ROI before saving calibration.", true);
    return;
  }

  saveCalibrationButton.disabled = true;
  setStatus("Computing reference dHash and saving calibration...");

  try {
    const { roi, hash } = computeHashFromSelection();

    if (optionsState?.calibration?.referenceHash) {
      const distance = hammingDistanceHex(hash, optionsState.calibration.referenceHash);
      setStatus(`Computed dHash. Distance to previous reference: ${distance}. Saving...`);
    }

    const response = await sendMessage(MESSAGE_TYPES.SAVE_CALIBRATION, {
      roi,
      referenceHash: hash,
    });

    applyOptionsState(response.optionsState);
    setStatus(`Calibration saved with reference hash ${hash}.`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    saveCalibrationButton.disabled = !hasSelection();
  }
});

(async () => {
  drawCanvas();

  try {
    await refreshOptionsState();
    setStatus("Ready.");
  } catch (error) {
    setStatus(error.message, true);
  }
})();
