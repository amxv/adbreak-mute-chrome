const OFFSCREEN_MESSAGE_TYPES = {
  PROCESS_FRAME: "OFFSCREEN_PROCESS_FRAME",
};

const NIBBLE_BIT_COUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

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
    throw new Error("dHash input size must be 9x8.");
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
    throw new Error("Cannot compare hashes of different lengths.");
  }

  let distance = 0;

  for (let i = 0; i < hashA.length; i += 1) {
    const nibbleA = parseInt(hashA[i], 16);
    const nibbleB = parseInt(hashB[i], 16);
    const xorValue = nibbleA ^ nibbleB;
    distance += NIBBLE_BIT_COUNT[xorValue];
  }

  return distance;
}

function detectBlankFrame(imageData) {
  const { data } = imageData;

  if (!data.length) {
    return {
      isBlank: true,
      meanLuma: 0,
      stdDev: 0,
      maxLuma: 0,
      nearBlackRatio: 1,
    };
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

  const isBlank = nearBlackRatio > 0.98 && maxLuma < 24 && stdDev < 6;

  return {
    isBlank,
    meanLuma,
    stdDev,
    maxLuma,
    nearBlackRatio,
  };
}

async function loadImage(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image")) {
    throw new Error("Invalid image payload.");
  }

  const image = new Image();
  image.src = dataUrl;
  await image.decode();

  return image;
}

async function processFrame({ dataUrl, roi, referenceHash, threshold }) {
  if (!roi || typeof roi !== "object") {
    throw new Error("ROI is missing.");
  }

  if (typeof referenceHash !== "string" || !/^[0-9a-f]{16}$/i.test(referenceHash)) {
    throw new Error("Reference hash is invalid.");
  }

  const normalizedThreshold = Number.isFinite(Number(threshold))
    ? Math.max(0, Math.min(64, Math.round(Number(threshold))))
    : 10;

  const image = await loadImage(dataUrl);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;

  if (!width || !height) {
    throw new Error("Captured frame has invalid dimensions.");
  }

  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = width;
  sourceCanvas.height = height;
  const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });

  sourceContext.drawImage(image, 0, 0, width, height);

  const roiPixels = normalizeRoiPixels(roi, width, height);
  const roiImageData = sourceContext.getImageData(roiPixels.x, roiPixels.y, roiPixels.w, roiPixels.h);
  const blankStats = detectBlankFrame(roiImageData);

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
  const currentHash = computeDHashFromImageData(hashImageData);
  const distance = hammingDistanceHex(currentHash, referenceHash.toLowerCase());
  const logoPresent = distance <= normalizedThreshold;

  return {
    hash: currentHash,
    distance,
    logoPresent,
    isBlank: blankStats.isBlank,
    blankStats,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== OFFSCREEN_MESSAGE_TYPES.PROCESS_FRAME) {
    return false;
  }

  processFrame(message)
    .then((result) => {
      sendResponse({ ok: true, ...result });
    })
    .catch((error) => {
      sendResponse({ ok: false, error: error?.message || "Failed to process frame." });
    });

  return true;
});
