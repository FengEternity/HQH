'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { jobNeedsWake, shouldWakeAfterRequeue, wakeVideoIngest } = require('./wakeVideoIngest');

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

describe('shouldWakeAfterRequeue', () => {
  it('wakes after new items are queued, or when an existing job still needs a worker', () => {
    assert.equal(shouldWakeAfterRequeue(2, null, 1000, 500), true);
    assert.equal(
      shouldWakeAfterRequeue(0, { phase: 'queued', claimedAt: 0 }, 1000, 500),
      true,
    );
    assert.equal(shouldWakeAfterRequeue(0, null, 1000, 500), false);
    assert.equal(
      shouldWakeAfterRequeue(0, { phase: 'running', claimedAt: 800 }, 1000, 500),
      false,
    );
  });
});

describe('wakeVideoIngest', () => {
  it('wakes the video-ingest service when the run call is accepted', async () => {
    let seen;
    const wake = await wakeVideoIngest(async (options) => {
      seen = options;
      return { statusCode: 200, data: { ok: true, started: true } };
    });
    assert.equal(wake.woke, true);
    assert.equal(wake.code, '');
    assert.equal(seen.path, '/run');
    assert.equal(seen.method, 'POST');
    assert.equal(seen.header['X-WX-SERVICE'], 'video-ingest');
  });

  it('returns false when the container responds with an error', async () => {
    const wake = await wakeVideoIngest(async () => ({
      statusCode: 500,
      data: { ok: false, code: 'NO_CREDENTIALS' },
    }));
    assert.equal(wake.woke, false);
    assert.equal(wake.code, 'NO_CREDENTIALS');
  });

  it('returns false when the container call throws', async () => {
    const error = new Error('container down');
    error.errCode = -504002;
    const wake = await wakeVideoIngest(async () => {
      throw error;
    });
    assert.equal(wake.woke, false);
    assert.equal(wake.code, '-504002');
  });
});
