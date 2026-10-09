'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../../../utils/api');

let pageConfig;
let listResponse;
api.admin = async () => listResponse;
global.Page = (config) => {
  pageConfig = config;
};
global.wx = {
  showToast() {},
  redirectTo() {},
};
require('./videos');
delete global.Page;
delete global.wx;

function video(overrides = {}) {
  return {
    _id: 'v1',
    title: '主机架设',
    intro: '对中讲解',
    brandId: 'b1',
    coverFileId: 'cloud://cover',
    videoFileId: 'cloud://processed',
    status: 'draft',
    ingest: { phase: 'ready', videoFileId: 'cloud://processed' },
    media: { playback: { compliant: true } },
    ...overrides,
  };
}

describe('admin video publish control', () => {
  it('derives the real publish control from strict playback readiness', async () => {
    listResponse = {
      videos: [
        video(),
        video({
          _id: 'v2',
          ingest: { phase: 'failed', videoFileId: 'cloud://processed' },
        }),
        video({ _id: 'v3', media: {} }),
      ],
    };
    const context = {
      data: { brandId: 'b1', videos: [] },
      setData(patch) {
        this.data = { ...this.data, ...patch };
      },
    };

    pageConfig.load.call(context);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(
      context.data.videos.map((item) => item.canPublish),
      [true, false, false],
    );
  });

  it('shows whether a video is queued or being transcoded', async () => {
    listResponse = {
      videos: [
        video({ _id: 'q', ingest: { phase: 'queued' } }),
        video({ _id: 'r', ingest: { phase: 'running' } }),
      ],
    };
    const context = {
      data: { brandId: 'b1', videos: [] },
      setData(patch) {
        this.data = { ...this.data, ...patch };
      },
    };

    pageConfig.load.call(context);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(
      context.data.videos.map((item) => item.ingestLabel),
      ['排队', '正在转'],
    );
  });
});
