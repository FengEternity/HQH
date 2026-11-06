'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { requeueResultTitle } = require('./requeueResult');

describe('requeueResultTitle', () => {
  it('says nothing needed reprocessing when the queue was left idle', () => {
    assert.equal(requeueResultTitle({ ok: true, enqueued: 0, woke: false, idle: true }), '没有需要重处理的视频');
    assert.equal(requeueResultTitle({ enqueued: 0, woke: false }), '没有需要重处理的视频');
  });

  it('reports a successful wake with or without new items', () => {
    assert.equal(requeueResultTitle({ enqueued: 2, woke: true }), '已入队并已唤醒');
    assert.equal(requeueResultTitle({ enqueued: 0, woke: true, idle: false }), '已唤醒，开始处理');
  });

  it('keeps queued work when the container did not wake', () => {
    assert.equal(requeueResultTitle({ enqueued: 3, woke: false, idle: false }), '已入队 3 条，稍后自动处理');
    assert.equal(requeueResultTitle({ enqueued: 0, woke: false, idle: false }), '容器未唤醒');
  });
});
