'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { jobNeedsWake, wakeVideoIngest } = require('./wakeVideoIngest');

describe('jobNeedsWake', () => {
  it('wakes a queued job and an expired running job only', () => {
    assert.equal(jobNeedsWake({ phase: 'queued', claimedAt: 0 }, 1000, 500), true);
    assert.equal(
      jobNeedsWake({ phase: 'running', claimedAt: 100 }, 1000, 500),
      true,
    );
    assert.equal(
      jobNeedsWake({ phase: 'running', claimedAt: 800 }, 1000, 500),
      false,
    );
    assert.equal(jobNeedsWake({ phase: 'done', claimedAt: 0 }, 1000, 500), false);
  });
});

describe('wakeVideoIngest', () => {
  it('returns false when the container call throws', async () => {
    const woke = await wakeVideoIngest(async () => {
      throw new Error('container down');
    });
    assert.equal(woke, false);
  });
});
