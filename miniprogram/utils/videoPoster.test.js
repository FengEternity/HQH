'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { frameToRgba, captureVideoPoster } = require('./videoPoster');

describe('frameToRgba', () => {
  it('turns a neutral I420 frame into opaque white', () => {
    const frame = {
      width: 2,
      height: 2,
      data: Uint8Array.from([235, 235, 235, 235, 128, 128]),
    };
    const image = frameToRgba(frame, 1280);
    assert.equal(image.width, 2);
    assert.equal(image.height, 2);
    assert.deepEqual(Array.from(image.rgba.slice(0, 4)), [255, 255, 255, 255]);
  });

  it('keeps an RGBA frame', () => {
    const frame = {
      width: 2,
      height: 2,
      data: Uint8Array.from([
        10, 20, 30, 255, 0, 0, 0, 255,
        0, 0, 0, 255, 0, 0, 0, 255,
      ]),
    };
    const image = frameToRgba(frame, 1280);
    assert.deepEqual(Array.from(image.rgba.slice(0, 4)), [10, 20, 30, 255]);
  });

  it('returns null when the frame is too short to be a picture', () => {
    assert.equal(frameToRgba({ width: 2, height: 2, data: Uint8Array.from([1, 2]) }, 1280), null);
  });
});

describe('captureVideoPoster', () => {
  it('returns an empty path when the runtime cannot decode video', async () => {
    const path = await captureVideoPoster({
      filePath: 'wxfile://tmp.mp4',
      createDecoder: () => null,
      loadCanvas: () => null,
    });
    assert.equal(path, '');
  });
});
