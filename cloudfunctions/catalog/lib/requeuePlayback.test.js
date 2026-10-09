'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

let needsPlaybackRequeue;
let summarizeIngestProgress;
try {
  ({ needsPlaybackRequeue, summarizeIngestProgress } = require('./requeuePlayback'));
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') {
    throw error;
  }
}

function video(overrides = {}) {
  return {
    _id: 'v1',
    videoFileId: 'cloud://old',
    status: 'published',
    intro: '手写简介',
    media: { playback: { compliant: false } },
    ingest: { phase: 'ready' },
    ...overrides,
  };
}

describe('needsPlaybackRequeue', () => {
  it('requeues a published video that is not playback compliant', () => {
    assert.equal(typeof needsPlaybackRequeue, 'function');
    assert.equal(needsPlaybackRequeue(video()), true);
  });

  it('skips a file already marked compliant', () => {
    assert.equal(
      needsPlaybackRequeue(video({ media: { playback: { compliant: true } } })),
      false,
    );
  });

  it('skips a record with no video file', () => {
    assert.equal(needsPlaybackRequeue(video({ videoFileId: '' })), false);
  });

  it('skips a video that is already queued or running', () => {
    assert.equal(needsPlaybackRequeue(video({ ingest: { phase: 'queued' } })), false);
    assert.equal(needsPlaybackRequeue(video({ ingest: { phase: 'running' } })), false);
  });

  it('requeues an old record that has never been probed', () => {
    assert.equal(needsPlaybackRequeue(video({ media: {}, ingest: {} })), true);
  });
});

describe('summarizeIngestProgress', () => {
  it('lists the video being transcoded ahead of queued and failed ones', () => {
    assert.equal(typeof summarizeIngestProgress, 'function');
    const summary = summarizeIngestProgress([
      { _id: 'a', title: '排队甲', ingest: { phase: 'queued' } },
      { _id: 'b', title: '正在转乙', ingest: { phase: 'running' } },
      { _id: 'c', title: '已完成', ingest: { phase: 'ready' } },
      { _id: 'd', title: '失败丙', ingest: { phase: 'failed' } },
    ]);

    assert.equal(summary.running, 1);
    assert.equal(summary.queued, 1);
    assert.equal(summary.failed, 1);
    assert.deepEqual(
      summary.items.map((item) => item.title),
      ['正在转乙', '排队甲', '失败丙'],
    );
    assert.deepEqual(
      summary.items.map((item) => item.label),
      ['正在转', '排队', '失败'],
    );
  });
});
