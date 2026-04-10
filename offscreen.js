const OFFSCREEN_MESSAGE_TYPES = {
  BUILD_TEMPLATE: "OFFSCREEN_BUILD_TEMPLATE",
  MATCH_FRAME: "OFFSCREEN_MATCH_FRAME",
};

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

const MATCH_THRESHOLD = 0.6;

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

async function loadImage(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image")) {
    throw new Error("Invalid image payload.");
  }

  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  return image;
}

function createCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
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
    return {
      name: segmentDef.name,
      width: imageData.width,
      height: imageData.height,
      data: toGrayscaleEdges(imageData),
    };
  });
}

async function buildTemplate({ dataUrl, label }) {
  const image = await loadImage(dataUrl);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;

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

  return {
    label,
    region: SEARCH_REGION,
    segments: buildTemplateSegments(sourceCanvas, region),
  };
}

async function matchFrame({ dataUrl, templates }) {
  if (!Array.isArray(templates) || !templates.length) {
    throw new Error("No templates provided.");
  }

  const image = await loadImage(dataUrl);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;

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

  for (const template of templates) {
    let scoreSum = 0;
    let count = 0;

    for (const templateSegment of template.segments) {
      const currentSegment = currentSegments.find((segment) => segment.name === templateSegment.name);

      if (!currentSegment) {
        continue;
      }

      scoreSum += compareArrays(currentSegment.data, templateSegment.data);
      count += 1;
    }

    const score = count ? scoreSum / count : 0;

    if (score > bestScore) {
      bestScore = score;
      bestTemplate = template;
    }
  }

  return {
    isBlank: false,
    logoPresent: bestScore >= MATCH_THRESHOLD,
    matchLabel: bestTemplate?.label || "Unknown",
    matchScore: bestScore,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === OFFSCREEN_MESSAGE_TYPES.BUILD_TEMPLATE) {
    buildTemplate(message)
      .then((template) => {
        sendResponse({ ok: true, template });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error?.message || "Failed to build template." });
      });

    return true;
  }

  if (message?.type === OFFSCREEN_MESSAGE_TYPES.MATCH_FRAME) {
    matchFrame(message)
      .then((result) => {
        sendResponse({ ok: true, ...result });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error?.message || "Failed to process frame." });
      });

    return true;
  }

  return false;
});
