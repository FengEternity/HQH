'use strict';

function clampByte(value) {
  if (value < 0) {
    return 0;
  }
  if (value > 255) {
    return 255;
  }
  return value;
}

function evenSize(value) {
  const size = Math.max(2, value);
  return size - (size % 2);
}

function frameToRgba(frame, maxWidth) {
  const srcW = frame && frame.width;
  const srcH = frame && frame.height;
  const raw = frame && frame.data;
  if (!srcW || !srcH || !raw) {
    return null;
  }
  const src = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const limit = Math.max(2, maxWidth || 1280);
  const scale = srcW > limit ? limit / srcW : 1;
  const width = evenSize(Math.round(srcW * scale));
  const height = evenSize(Math.round(srcH * scale));
  const rgbaSize = srcW * srcH * 4;
  const i420Size = (srcW * srcH * 3) / 2;
  if (src.length === rgbaSize) {
    return sampleRgba(src, srcW, srcH, width, height);
  }
  if (srcW % 2 !== 0 || srcH % 2 !== 0 || src.length < i420Size) {
    return null;
  }
  return sampleI420(src, srcW, srcH, width, height);
}

function sampleRgba(src, srcW, srcH, width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(srcH - 1, Math.floor((y * srcH) / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(srcW - 1, Math.floor((x * srcW) / width));
      const from = (sy * srcW + sx) * 4;
      const to = (y * width + x) * 4;
      rgba[to] = src[from];
      rgba[to + 1] = src[from + 1];
      rgba[to + 2] = src[from + 2];
      rgba[to + 3] = src[from + 3] || 255;
    }
  }
  return { width, height, rgba };
}

function sampleI420(src, srcW, srcH, width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const ySize = srcW * srcH;
  const uvWidth = srcW / 2;
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(srcH - 1, Math.floor((y * srcH) / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(srcW - 1, Math.floor((x * srcW) / width));
      const luma = src[sy * srcW + sx];
      const uvIndex = (sy >> 1) * uvWidth + (sx >> 1);
      const chromaU = src[ySize + uvIndex];
      const chromaV = src[ySize + (ySize >> 2) + uvIndex];
      const c = luma - 16;
      const d = chromaU - 128;
      const e = chromaV - 128;
      const to = (y * width + x) * 4;
      rgba[to] = clampByte((298 * c + 409 * e + 128) >> 8);
      rgba[to + 1] = clampByte((298 * c - 100 * d - 208 * e + 128) >> 8);
      rgba[to + 2] = clampByte((298 * c + 516 * d + 128) >> 8);
      rgba[to + 3] = 255;
    }
  }
  return { width, height, rgba };
}

function captureVideoPoster({
  filePath,
  createDecoder,
  loadCanvas,
  exportCanvas,
  frameToImage = frameToRgba,
}) {
  const source = String(filePath || '').trim();
  if (!source || typeof createDecoder !== 'function' || typeof loadCanvas !== 'function') {
    return Promise.resolve('');
  }
  const decoder = createDecoder();
  if (!decoder || typeof decoder.start !== 'function' || typeof decoder.getFrameData !== 'function') {
    return Promise.resolve('');
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (path) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        decoder.stop();
      } catch (_err) {
        // 解码器可能还没真正开始。
      }
      resolve(path || '');
    };
    const timer = setTimeout(() => finish(''), 8000);
    const paint = (frame) => {
      const image = frameToImage(frame, 1280);
      if (!image) {
        finish('');
        return;
      }
      Promise.resolve(loadCanvas())
        .then((canvas) => {
          if (!canvas || typeof exportCanvas !== 'function') {
            finish('');
            return null;
          }
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d');
          const pixels = context.createImageData(image.width, image.height);
          pixels.data.set(image.rgba);
          context.putImageData(pixels, 0, 0);
          return exportCanvas(canvas);
        })
        .then((path) => finish(path))
        .catch(() => finish(''));
    };
    const pullFrame = (left) => {
      if (settled) {
        return;
      }
      let frame = null;
      try {
        frame = decoder.getFrameData();
      } catch (_err) {
        finish('');
        return;
      }
      if (frame && frame.width && frame.data) {
        paint(frame);
        return;
      }
      if (left <= 0) {
        finish('');
        return;
      }
      setTimeout(() => pullFrame(left - 1), 50);
    };
    if (typeof decoder.on === 'function') {
      decoder.on('start', () => pullFrame(30));
      decoder.on('error', () => finish(''));
    }
    try {
      const started = decoder.start({ source, mode: 0, abortAudio: true });
      if (started && typeof started.catch === 'function') {
        started.catch(() => finish(''));
      }
    } catch (_err) {
      finish('');
    }
  });
}

module.exports = {
  frameToRgba,
  captureVideoPoster,
};
