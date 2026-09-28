'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

let pageConfig;
global.Page = (config) => {
  pageConfig = config;
};
require('./edit');
delete global.Page;

function video(overrides = {}) {
  return {
    videoFileId: 'cloud://processed',
    ingest: {
      phase: 'ready',
      videoFileId: 'cloud://processed',
      asr: 'ready',
      introSource: 'auto',
    },
    media: { playback: { compliant: true } },
    ...overrides,
  };
}

describe('deriveVideoUi', () => {
  function apply(found) {
    const context = {
      data: { id: 'v1' },
      setData(patch) {
        this.data = { ...this.data, ...patch };
      },
    };
    pageConfig.applyVideo.call(context, found, 'b1');
    return context.data;
  }

  it('allows publish only for the processed file with a compliant playback check', () => {
    assert.equal(apply(video()).canPublish, true);
    assert.equal(
      apply(video({ ingest: { ...video().ingest, videoFileId: 'cloud://old' } }))
        .canPublish,
      false,
    );
    assert.equal(apply(video({ media: {} })).canPublish, false);
  });

  it('shows the required hint for waiting, failed, and unchecked video', () => {
    assert.equal(
      apply(video({ ingest: { ...video().ingest, phase: 'queued' } })).ingestHint,
      '等待视频处理',
    );
    assert.equal(
      apply(video({ ingest: { ...video().ingest, phase: 'running' } })).ingestHint,
      '等待视频处理',
    );
    assert.equal(
      apply(video({ ingest: { ...video().ingest, phase: 'failed' } })).ingestHint,
      '视频处理失败，请重试',
    );
    assert.equal(
      apply(video({ media: {} })).ingestHint,
      '视频未通过播放检查',
    );
  });
});
