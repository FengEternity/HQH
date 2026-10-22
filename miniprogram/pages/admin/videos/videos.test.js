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

  it('labels a pending review and a long wait without an intro', async () => {
    const started = Date.now() - 16 * 60 * 1000;
    listResponse = {
      videos: [
        video({
          _id: 'review',
          introReview: 'pending',
          autoIntro: '自动稿',
          ingest: { phase: 'ready', asr: 'ready', videoFileId: 'cloud://processed' },
        }),
        video({
          _id: 'wait',
          intro: '',
          autoIntro: '',
          humanIntro: '',
          ingest: { phase: 'queued', queuedAt: started, videoFileId: 'cloud://processed' },
        }),
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
      ['待确认', '可先手写'],
    );
  });

  it('refreshes every 8 seconds while a video is queued and stops when hidden', async () => {
    const timers = [];
    const originalSet = global.setInterval;
    const originalClear = global.clearInterval;
    let cleared = 0;
    global.setInterval = (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    };
    global.clearInterval = () => {
      cleared += 1;
    };
    listResponse = {
      videos: [video({ _id: 'q', ingest: { phase: 'queued', videoFileId: 'cloud://processed' } })],
    };
    const context = {
      data: { brandId: 'b1', videos: [] },
      setData(patch) {
        this.data = { ...this.data, ...patch };
      },
    };
    context.load = pageConfig.load.bind(context);
    context.stopListPoll = pageConfig.stopListPoll.bind(context);

    try {
      pageConfig.onShow.call(context);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(timers.length, 1);
      assert.equal(timers[0].ms, 8000);

      listResponse = { videos: [video()] };
      timers[0].fn();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(cleared > 0, true);

      pageConfig.onHide.call(context);
    } finally {
      global.setInterval = originalSet;
      global.clearInterval = originalClear;
    }
  });
});
