'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ingestEntryLabel } = require('./ingestEntryLabel');

describe('ingestEntryLabel', () => {
  it('shows 进入 when the read failed or nothing is in progress', () => {
    assert.equal(ingestEntryLabel({ failedToLoad: true, running: 2, queued: 3, failed: 4 }), '进入');
    assert.equal(ingestEntryLabel({ running: 0, queued: 0, failed: 0 }), '进入');
    assert.equal(ingestEntryLabel({}), '进入');
    assert.equal(ingestEntryLabel({ running: 'no', queued: null, failed: -1 }), '进入');
  });

  it('prefers running, then queued, then failed', () => {
    assert.equal(ingestEntryLabel({ running: 1, queued: 4, failed: 2 }), '正在转');
    assert.equal(ingestEntryLabel({ running: 0, queued: 4, failed: 2 }), '4 条排队');
    assert.equal(ingestEntryLabel({ queued: 0, failed: 2 }), '2 条失败');
  });
});
