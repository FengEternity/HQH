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

  it('shows the intro early while playback is still processing', () => {
    const data = apply(video({
      autoIntro: '千寻本期讲解如何打开项目。',
      ingest: { ...video().ingest, phase: 'running' },
    }));
    assert.equal(data.ingestHint, '简介已出，播放文件仍在处理');
    assert.equal(data.autoIntro, '千寻本期讲解如何打开项目。');
    assert.equal(data.ingestBusy, true);
  });

  it('asks for a handwritten intro and shows retry when the auto intro was rejected', () => {
    const data = apply(video({
      ingest: {
        phase: 'ready',
        videoFileId: 'cloud://processed',
        asr: 'ready',
        introSource: 'placeholder',
      },
    }));
    assert.equal(data.ingestHint, '自动简介未通过，请手写简介');
    assert.equal(data.showRetryIngest, true);
    assert.equal(data.canRetryIngest, true);
  });

  it('asks for a handwritten intro when transcription failed after playback was ready', () => {
    const data = apply(video({
      ingest: {
        phase: 'ready',
        videoFileId: 'cloud://processed',
        asr: 'failed',
        introSource: 'placeholder',
      },
    }));
    assert.equal(data.ingestHint, '转写失败，播放文件已更新，请手写简介后再上架');
    assert.equal(data.canPublish, true);
  });

  it('opens an old video with the existing title and intro in the human boxes', () => {
    const placeholder = apply(video({
      title: '点放样',
      intro: '讲解处理中，完成后请核对简介。',
      ingest: { ...video().ingest, introSource: 'placeholder' },
    }));
    assert.equal(placeholder.humanTitle, '点放样');
    assert.equal(placeholder.autoTitle, '');
    assert.equal(placeholder.humanIntro, '');
    assert.equal(placeholder.autoIntro, '');

    const handwritten = apply(video({
      title: '点放样',
      intro: '人工写的简介',
      ingest: { ...video().ingest, introSource: 'placeholder' },
    }));
    assert.equal(handwritten.humanIntro, '人工写的简介');
    assert.equal(handwritten.autoIntro, '');

    const generated = apply(video({
      title: '点放样',
      intro: '自动写的简介',
      ingest: { ...video().ingest, introSource: 'auto' },
    }));
    assert.equal(generated.autoIntro, '自动写的简介');
    assert.equal(generated.humanIntro, '');
  });

  it('keeps stored auto and human copies when both fields exist', () => {
    const data = apply(video({
      title: '人工标题',
      intro: '人工简介',
      autoTitle: '文件名',
      humanTitle: '人工标题',
      autoIntro: '自动简介',
      humanIntro: '人工简介',
    }));
    assert.equal(data.autoTitle, '文件名');
    assert.equal(data.humanTitle, '人工标题');
    assert.equal(data.autoIntro, '自动简介');
    assert.equal(data.humanIntro, '人工简介');
  });
});
