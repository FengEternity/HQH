'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { CLAIM_TIMEOUT_MS } = require('./videoIngest');
const {
  canEnqueue,
  createJobRecord,
  claimJobRecord,
  finishJobRecord,
} = require('./videoIngestJobs');

describe('canEnqueue', () => {
  it('returns true for idle, ready, and failed phases', () => {
    assert.equal(canEnqueue('idle'), true);
    assert.equal(canEnqueue('ready'), true);
    assert.equal(canEnqueue('failed'), true);
  });

  it('returns false for queued and running phases', () => {
    assert.equal(canEnqueue('queued'), false);
    assert.equal(canEnqueue('running'), false);
  });
});

describe('createJobRecord', () => {
  it('creates a queued job with zero claim metadata', () => {
    const job = createJobRecord({ videoId: 'v1', mediaRevision: 2, now: 1000 });
    assert.deepEqual(job, {
      videoId: 'v1',
      mediaRevision: 2,
      phase: 'queued',
      claimedAt: 0,
      claimedBy: '',
      createdAt: 1000,
      updatedAt: 1000,
    });
  });
});

describe('claimJobRecord', () => {
  const baseJob = {
    videoId: 'v1',
    mediaRevision: 1,
    phase: 'queued',
    claimedAt: 0,
    claimedBy: '',
    createdAt: 100,
    updatedAt: 100,
  };

  it('claims a queued job', () => {
    const claimed = claimJobRecord({
      job: baseJob,
      workerId: 'worker-a',
      now: 2000,
      timeoutMs: CLAIM_TIMEOUT_MS,
    });
    assert.deepEqual(claimed, {
      ...baseJob,
      phase: 'running',
      claimedAt: 2000,
      claimedBy: 'worker-a',
      updatedAt: 2000,
    });
  });

  it('does not claim a fresh running job', () => {
    const running = {
      ...baseJob,
      phase: 'running',
      claimedAt: 2000,
      claimedBy: 'worker-a',
      updatedAt: 2000,
    };
    const claimed = claimJobRecord({
      job: running,
      workerId: 'worker-b',
      now: 2000 + CLAIM_TIMEOUT_MS - 1,
      timeoutMs: CLAIM_TIMEOUT_MS,
    });
    assert.equal(claimed, null);
  });

  it('claims an expired running job for another worker', () => {
    const running = {
      ...baseJob,
      phase: 'running',
      claimedAt: 1000,
      claimedBy: 'worker-a',
      updatedAt: 1000,
    };
    const claimed = claimJobRecord({
      job: running,
      workerId: 'worker-b',
      now: 1000 + CLAIM_TIMEOUT_MS,
      timeoutMs: CLAIM_TIMEOUT_MS,
    });
    assert.deepEqual(claimed, {
      ...running,
      phase: 'running',
      claimedAt: 1000 + CLAIM_TIMEOUT_MS,
      claimedBy: 'worker-b',
      updatedAt: 1000 + CLAIM_TIMEOUT_MS,
    });
  });

  it('returns null for done jobs', () => {
    const done = {
      ...baseJob,
      phase: 'done',
      claimedAt: 500,
      claimedBy: 'worker-a',
      updatedAt: 500,
    };
    const claimed = claimJobRecord({
      job: done,
      workerId: 'worker-b',
      now: 9000,
      timeoutMs: CLAIM_TIMEOUT_MS,
    });
    assert.equal(claimed, null);
  });
});

describe('finishJobRecord', () => {
  it('marks a running job as done', () => {
    const running = {
      videoId: 'v1',
      mediaRevision: 1,
      phase: 'running',
      claimedAt: 1000,
      claimedBy: 'worker-a',
      createdAt: 100,
      updatedAt: 1000,
    };
    const finished = finishJobRecord({ job: running, now: 5000, phase: 'done' });
    assert.deepEqual(finished, {
      ...running,
      phase: 'done',
      updatedAt: 5000,
    });
  });

  it('marks a running job as dead', () => {
    const running = {
      videoId: 'v1',
      mediaRevision: 1,
      phase: 'running',
      claimedAt: 1000,
      claimedBy: 'worker-a',
      createdAt: 100,
      updatedAt: 1000,
    };
    const finished = finishJobRecord({ job: running, now: 5000, phase: 'dead' });
    assert.deepEqual(finished, {
      ...running,
      phase: 'dead',
      updatedAt: 5000,
    });
  });

  it('rejects queued as finish phase', () => {
    const running = {
      videoId: 'v1',
      mediaRevision: 1,
      phase: 'running',
      claimedAt: 1000,
      claimedBy: 'worker-a',
      createdAt: 100,
      updatedAt: 1000,
    };
    assert.throws(
      () => finishJobRecord({ job: running, now: 5000, phase: 'queued' }),
      (err) => err.code === 'BAD_INPUT' && /done|dead/.test(err.message),
    );
  });

  it('rejects running as finish phase', () => {
    const running = {
      videoId: 'v1',
      mediaRevision: 1,
      phase: 'running',
      claimedAt: 1000,
      claimedBy: 'worker-a',
      createdAt: 100,
      updatedAt: 1000,
    };
    assert.throws(
      () => finishJobRecord({ job: running, now: 5000, phase: 'running' }),
      (err) => err.code === 'BAD_INPUT' && /done|dead/.test(err.message),
    );
  });
});
