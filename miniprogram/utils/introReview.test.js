'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { introWaitMs, listIngestLabel } = require('./introReview');

const MINUTE = 60 * 1000;

describe('introWaitMs', () => {
  it('uses 15 minutes when the duration is missing', () => {
    assert.equal(introWaitMs(undefined), 15 * MINUTE);
    assert.equal(introWaitMs(0), 15 * MINUTE);
    assert.equal(introWaitMs(Number.NaN), 15 * MINUTE);
  });

  it('scales with duration and keeps the 15 and 30 minute bounds', () => {
    assert.equal(introWaitMs(3 * 60), 15 * MINUTE);
    assert.equal(introWaitMs(8 * 60), 24 * MINUTE);
    assert.equal(introWaitMs(20 * 60), 30 * MINUTE);
  });

  it('never waits longer than the 45 minute fallback', () => {
    assert.ok(introWaitMs(24 * 60 * 60) <= 45 * MINUTE);
  });
});

describe('listIngestLabel wait', () => {
  const now = 1_000_000_000_000;

  function queued(durationSec, elapsedMs) {
    return {
      intro: '',
      durationSec,
      ingest: { phase: 'queued', queuedAt: now - elapsedMs },
    };
  }

  it('waits longer for a long video and still falls back', () => {
    assert.equal(listIngestLabel(queued(20 * 60, 16 * MINUTE), now), '排队');
    assert.equal(listIngestLabel(queued(20 * 60, 30 * MINUTE), now), '可先手写');
    assert.equal(listIngestLabel(queued(0, 15 * MINUTE), now), '可先手写');
  });
});
