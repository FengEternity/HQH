'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  minScale,
  clampScale,
  clampOffset,
  initialView,
  sourceRect,
  isSmallCover,
  EXPORT_WIDTH,
  EXPORT_HEIGHT,
} = require('./coverCrop');

describe('coverCrop', () => {
  it('uses the larger axis scale so the frame has no blank edge', () => {
    assert.equal(minScale(1920, 1080, 320, 180), 320 / 1920);
    assert.equal(minScale(1000, 2000, 320, 180), 320 / 1000);
  });

  it('clamps scale between minimum and four times minimum', () => {
    assert.equal(clampScale(0.1, 0.5), 0.5);
    assert.equal(clampScale(3, 0.5), 2);
    assert.equal(clampScale(0.8, 0.5), 0.8);
  });

  it('centers a 16:9 image flush to a 16:9 frame', () => {
    const view = initialView(1920, 1080, 320, 180);
    assert.equal(view.scale, 320 / 1920);
    assert.equal(view.offsetX, 0);
    assert.equal(view.offsetY, 0);
  });

  it('centers the tall image while its width fills the frame', () => {
    const view = initialView(1000, 2000, 320, 180);
    assert.equal(view.scale, 320 / 1000);
    assert.equal(view.offsetX, 0);
    assert.equal(view.offsetY, (180 - 2000 * view.scale) / 2);
  });

  it('rejects a pan that would expose an empty frame edge', () => {
    const scale = minScale(1920, 1080, 320, 180);
    const out = clampOffset(40, 10, scale, 1920, 1080, 320, 180);
    assert.deepEqual(out, { offsetX: 0, offsetY: 0 });
  });

  it('maps the visible frame to integer source pixels inside the bitmap', () => {
    const view = initialView(1920, 1080, 320, 180);
    const rect = sourceRect(view.offsetX, view.offsetY, view.scale, 1920, 1080, 320, 180);
    assert.deepEqual(rect, {
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
      destWidth: EXPORT_WIDTH,
      destHeight: EXPORT_HEIGHT,
    });
  });

  it('keeps a rounded source rect within the image bounds', () => {
    const rect = sourceRect(-1.3, -2.7, 0.37, 1000, 700, 320, 180);
    assert.ok(Number.isInteger(rect.x));
    assert.ok(Number.isInteger(rect.y));
    assert.ok(Number.isInteger(rect.width));
    assert.ok(Number.isInteger(rect.height));
    assert.ok(rect.x >= 0 && rect.y >= 0);
    assert.ok(rect.x + rect.width <= 1000);
    assert.ok(rect.y + rect.height <= 700);
    assert.equal(rect.width / rect.height, 16 / 9);
  });

  it('marks a cover small when either original edge is under 640px', () => {
    assert.equal(isSmallCover(639, 2000), true);
    assert.equal(isSmallCover(1280, 720), false);
  });
});
