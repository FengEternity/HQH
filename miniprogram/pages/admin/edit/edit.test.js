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
      '没有生成简介，请手写后再保存上架。',
    );
    assert.equal(
      apply(video({
        humanIntro: '已有简介',
        intro: '已有简介',
        ingest: { ...video().ingest, phase: 'failed' },
      })).ingestHint,
      '视频处理失败，请重试',
    );
    assert.equal(
      apply(video({ humanIntro: '已有简介', intro: '已有简介', media: {} })).ingestHint,
      '视频未通过播放检查',
    );
  });

  it('shows the intro early while playback is still processing', () => {
    const data = apply(video({
      autoIntro: '千寻本期讲解如何打开项目。',
      ingest: { ...video().ingest, phase: 'running' },
    }));
    assert.equal(data.ingestHint, '自动简介已填入，请核对。保存后才能上架。播放文件仍在处理');
    assert.equal(data.autoIntro, '千寻本期讲解如何打开项目。');
    assert.equal(data.ingestBusy, true);
  });

  it('offers a handwritten intro after fifteen minutes without a draft', () => {
    const data = apply(video({
      intro: '讲解处理中，完成后请核对简介。',
      ingest: {
        ...video().ingest,
        phase: 'running',
        introSource: 'placeholder',
        queuedAt: Date.now() - 16 * 60 * 1000,
      },
    }));
    assert.equal(
      data.ingestHint,
      '处理时间较长，可先手写简介。自动稿出来后留在对照里，不会盖掉你写的。',
    );
  });

  it('waits longer before offering a handwritten intro for a long video', () => {
    const ingest = {
      ...video().ingest,
      phase: 'running',
      introSource: 'placeholder',
      queuedAt: Date.now() - 16 * 60 * 1000,
    };
    const early = apply(video({
      intro: '讲解处理中，完成后请核对简介。',
      durationSec: 20 * 60,
      ingest,
    }));
    assert.equal(early.ingestHint, '等待视频处理');

    const due = apply(video({
      intro: '讲解处理中，完成后请核对简介。',
      durationSec: 20 * 60,
      ingest: { ...ingest, queuedAt: Date.now() - 30 * 60 * 1000 },
    }));
    assert.equal(
      due.ingestHint,
      '处理时间较长，可先手写简介。自动稿出来后留在对照里，不会盖掉你写的。',
    );
  });

  it('asks for a handwritten intro and shows retry when the auto intro was rejected', () => {
    const rejected = apply(video({
      autoIntro: '华测RTK支持四参数计算。',
      intro: '华测RTK支持四参数计算。',
      introReview: 'pending',
      introGate: { ok: false, reason: 'term 四参数' },
      ingest: {
        phase: 'ready',
        videoFileId: 'cloud://processed',
        asr: 'ready',
        introSource: 'auto',
      },
    }));
    assert.equal(
      rejected.ingestHint,
      '自动简介已填入，但未通过检查（四参数未在口播里出现）。请核对修改，保存后才能上架。',
    );
    assert.equal(rejected.showRetryIngest, true);
    assert.equal(rejected.canRetryIngest, true);

    const missing = apply(video({
      ingest: {
        phase: 'ready',
        videoFileId: 'cloud://processed',
        asr: 'ready',
        introSource: 'placeholder',
      },
    }));
    assert.equal(missing.ingestHint, '没有生成简介，请手写后再保存上架。');
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
    assert.equal(data.ingestHint, '没有生成简介，请手写后再保存上架。');
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
    assert.equal(data.titleText, '人工标题');
    assert.equal(data.introText, '人工简介');
    assert.equal(data.canReplaceTitle, true);
    assert.equal(data.canReplaceIntro, true);
    assert.equal(
      apply(video({
        autoIntro: '自动简介',
        humanIntro: '人工简介',
        intro: '人工简介',
        introReview: 'confirmed',
        introGate: { ok: false, reason: 'term 四参数' },
      })).ingestHint,
      '待核对后上架 未通过检查（四参数未在口播里出现）',
    );
  });

  it('shows the generated title and intro when nothing was written by hand', () => {
    const data = apply(video({
      autoTitle: '文件名',
      humanTitle: '',
      autoIntro: '自动简介',
      humanIntro: '',
    }));
    assert.equal(data.titleText, '文件名');
    assert.equal(data.introText, '自动简介');
    assert.equal(data.canReplaceTitle, false);
    assert.equal(data.canReplaceIntro, false);
  });

  it('replacing the intro drops the handwritten copy and shows the generated one', () => {
    const context = {
      data: {
        humanTitle: '人工标题',
        autoTitle: '文件名',
        humanIntro: '人工简介',
        autoIntro: '自动简介',
        canReplaceIntro: true,
        brandId: 'b1',
      },
      setData(patch, callback) {
        this.data = { ...this.data, ...patch };
        if (callback) {
          callback();
        }
      },
      persist() {
        return Promise.resolve('v1');
      },
    };
    pageConfig.replaceIntro.call(context);
    assert.equal(context.data.humanIntro, '');
    assert.equal(context.data.introText, '自动简介');
    assert.equal(context.data.canReplaceIntro, false);
    assert.equal(context.data.humanTitle, '人工标题');
  });
});

describe('uploadVideo', () => {
  function uploadContext(extra) {
    return {
      data: {
        autoTitle: '',
        humanTitle: '',
        humanIntro: '',
        autoIntro: '',
        coverFileId: '',
        videoFileId: '',
      },
      setData(patch, callback) {
        this.data = { ...this.data, ...patch };
        if (callback) {
          callback();
        }
      },
      ensureSaved: async () => 'v1',
      uploadCloudFile: async () => 'cloud://video',
      persistUploadedVideo: async () => 'v1',
      reloadVideo: async () => {},
      pickLocalVideo: pageConfig.pickLocalVideo,
      pickChatVideo: pageConfig.pickChatVideo,
      acceptPickedVideo: pageConfig.acceptPickedVideo,
      showPickError: pageConfig.showPickError,
      ...extra,
    };
  }

  it('从聊天记录选择时用文件名填标题，不在客户端解码视频', async () => {
    const originalWx = global.wx;
    let resolveSaved;
    const saved = new Promise((resolve) => {
      resolveSaved = resolve;
    });
    global.wx = {
      getSystemInfoSync() {
        return { platform: 'ios' };
      },
      showActionSheet({ itemList, success }) {
        assert.deepEqual(itemList, ['从手机相册', '从聊天记录']);
        success({ tapIndex: 1 });
      },
      chooseMessageFile({ success }) {
        success({
          tempFiles: [{ path: 'wxfile://video.mp4', name: '千寻数据导入.mp4' }],
        });
      },
      chooseMedia() {
        throw new Error('聊天记录不应打开相册');
      },
      createVideoDecoder() {
        throw new Error('客户端不应解码视频');
      },
      showToast({ title }) {
        if (/视频已保存/.test(title)) {
          resolveSaved();
        }
      },
    };
    const context = uploadContext();

    try {
      pageConfig.uploadVideo.call(context);
      await saved;
      assert.equal(context.data.autoTitle, '千寻数据导入');
      assert.equal(context.data.videoFileId, 'cloud://video');
    } finally {
      global.wx = originalWx;
    }
  });

  it('从相册或电脑文件夹选择时上传视频，没有文件名就保留已有标题', async () => {
    const originalWx = global.wx;
    let resolveSaved;
    const saved = new Promise((resolve) => {
      resolveSaved = resolve;
    });
    let uploadedPath = '';
    global.wx = {
      getSystemInfoSync() {
        return { platform: 'windows' };
      },
      showActionSheet({ itemList, success }) {
        assert.deepEqual(itemList, ['从电脑文件夹', '从聊天记录']);
        success({ tapIndex: 0 });
      },
      chooseMedia({ success }) {
        success({
          tempFiles: [{ tempFilePath: 'wxfile://tmp_abc.mp4' }],
        });
      },
      chooseMessageFile() {
        throw new Error('本地文件不应打开聊天记录');
      },
      createVideoDecoder() {
        throw new Error('客户端不应解码视频');
      },
      showToast({ title }) {
        if (/视频已保存/.test(title)) {
          resolveSaved();
        }
      },
    };
    const context = uploadContext({
      uploadCloudFile: async (kind, filePath) => {
        uploadedPath = filePath;
        return 'cloud://video';
      },
    });
    context.data.autoTitle = '已有标题';
    context.data.titleText = '已有标题';

    try {
      pageConfig.uploadVideo.call(context);
      await saved;
      assert.equal(uploadedPath, 'wxfile://tmp_abc.mp4');
      assert.equal(context.data.autoTitle, '已有标题');
      assert.equal(context.data.titleText, '已有标题');
      assert.equal(context.data.videoFileId, 'cloud://video');
    } finally {
      global.wx = originalWx;
    }
  });
});
