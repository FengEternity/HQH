'use strict';

const COVER_RATIO = 16 / 9;
const EXPORT_WIDTH = 1280;
const EXPORT_HEIGHT = 720;
const MAX_SCALE_FACTOR = 4;
const SMALL_EDGE = 640;

function minScale(imgW, imgH, frameW, frameH) {
  return Math.max(frameW / imgW, frameH / imgH);
}

function clampScale(scale, minimum) {
  return Math.min(minimum * MAX_SCALE_FACTOR, Math.max(minimum, scale));
}

function clampOffset(offsetX, offsetY, scale, imgW, imgH, frameW, frameH) {
  const minX = Math.min(0, frameW - imgW * scale);
  const minY = Math.min(0, frameH - imgH * scale);
  return {
    offsetX: Math.min(0, Math.max(minX, offsetX)),
    offsetY: Math.min(0, Math.max(minY, offsetY)),
  };
}

function initialView(imgW, imgH, frameW, frameH) {
  const scale = minScale(imgW, imgH, frameW, frameH);
  return {
    scale,
    offsetX: (frameW - imgW * scale) / 2,
    offsetY: (frameH - imgH * scale) / 2,
  };
}

function sourceRect(offsetX, offsetY, scale, imgW, imgH, frameW, frameH) {
  const centerX = (-offsetX + frameW / 2) / scale;
  const centerY = (-offsetY + frameH / 2) / scale;
  const visibleWidth = Math.min(
    frameW / scale,
    (frameH / scale) * COVER_RATIO,
    imgW,
    imgH * COVER_RATIO,
  );
  const units = Math.floor((visibleWidth + 1e-7) / 16);
  const width = units > 0 ? units * 16 : Math.max(1, Math.floor(visibleWidth));
  const height = units > 0 ? units * 9 : Math.max(1, Math.floor(width / COVER_RATIO));
  const x = Math.max(0, Math.min(imgW - width, Math.round(centerX - width / 2)));
  const y = Math.max(0, Math.min(imgH - height, Math.round(centerY - height / 2)));
  return { x, y, width, height, destWidth: EXPORT_WIDTH, destHeight: EXPORT_HEIGHT };
}

function isSmallCover(imgW, imgH) {
  return imgW < SMALL_EDGE || imgH < SMALL_EDGE;
}

module.exports = {
  COVER_RATIO,
  EXPORT_WIDTH,
  EXPORT_HEIGHT,
  MAX_SCALE_FACTOR,
  SMALL_EDGE,
  minScale,
  clampScale,
  clampOffset,
  initialView,
  sourceRect,
  isSmallCover,
};
