'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

let needsPlaybackRequeue;
try {
  ({ needsPlaybackRequeue } = require('./requeuePlayback'));
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
