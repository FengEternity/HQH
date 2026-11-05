'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

describe('pickVideo', () => {
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
      pageConfig.pickChatVideo.call(context);
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
      pageConfig.pickLocalVideo.call(context);
      await saved;
      assert.equal(uploadedPath, 'wxfile://tmp_abc.mp4');
      assert.equal(context.data.autoTitle, '已有标题');
      assert.equal(context.data.titleText, '已有标题');
      assert.equal(context.data.videoFileId, 'cloud://video');
    } finally {
      global.wx = originalWx;
    }
  });

  it('保存时用表单里的标题，页面数据还停留在文件名也写入手改名称', () => {
    const saved = [];
    const context = {
      data: {
        brandId: 'b1',
        id: 'v1',
        humanTitle: '',
        autoTitle: 'NS2611021636327571',
        titleText: 'NS2611021636327571',
        humanIntro: '',
        autoIntro: '自动简介',
        introText: '自动简介',
        modelName: '',
        tags: '',
        coverFileId: '',
        videoFileId: 'cloud://v',
      },
      setData(patch, callback) {
        this.data = { ...this.data, ...patch };
        if (callback) {
          callback();
        }
      },
      persist(silent) {
        saved.push({
          silent,
          humanTitle: this.data.humanTitle,
          titleText: this.data.titleText,
          modelName: this.data.modelName,
          tags: this.data.tags,
        });
        return Promise.resolve('v1');
      },
    };

    pageConfig.save.call(context, {
      detail: {
        value: {
          title: '中海达点放样',
          intro: '自动简介',
          modelName: 'iRTK5',
          tags: '对中',
        },
      },
    });

    assert.equal(context.data.humanTitle, '中海达点放样');
    assert.equal(context.data.titleText, '中海达点放样');
    assert.equal(context.data.humanIntro, '');
    assert.equal(saved[0].humanTitle, '中海达点放样');
    assert.equal(saved[0].modelName, 'iRTK5');
    assert.equal(saved[0].tags, '对中');

    pageConfig.save.call(context, {
      detail: {
        value: {
          title: 'NS2611021636327571',
          intro: '自动简介',
        },
      },
    });
    assert.equal(context.data.humanTitle, '');
    assert.equal(saved[1].humanTitle, '');

    const wxml = fs.readFileSync(path.join(__dirname, 'edit.wxml'), 'utf8');
    assert.match(wxml, /bindsubmit="save"/);
    assert.match(wxml, /name="title"/);
    assert.match(wxml, /name="intro"/);
    assert.match(wxml, /name="modelName"/);
    assert.match(wxml, /name="tags"/);
    assert.match(wxml, /form-type="submit"/);
    assert.doesNotMatch(wxml, /bindtap="save"/);
  });

  it('处理中的刷新保留正在编辑的标题，没有手写简介时仍填入生成稿', () => {
    const context = {
      data: {
        id: 'v1',
        titleText: '手改名称',
        humanTitle: '',
        autoTitle: 'NS2611021636327571',
        introText: '',
        humanIntro: '',
        autoIntro: '',
        modelName: '旧型号',
        tags: '旧标签',
        coverFileId: '',
        posterUrl: '',
      },
      setData(patch, callback) {
        this.data = { ...this.data, ...patch };
        if (callback) {
          callback();
        }
      },
      watchIngest() {},
      stopWatchIngest() {},
    };

    pageConfig.applyVideo.call(
      context,
      video({
        autoTitle: 'NS2611021636327571',
        humanTitle: '',
        autoIntro: '生成的简介',
        humanIntro: '',
        modelName: '新型号',
        tags: ['新标签'],
        ingest: { ...video().ingest, phase: 'running' },
      }),
      'b1',
      { keepEdits: true },
    );

    assert.equal(context.data.titleText, '手改名称');
    assert.equal(context.data.introText, '生成的简介');
    assert.equal(context.data.modelName, '旧型号');
    assert.equal(context.data.tags, '旧标签');

    context.data.introText = '手写简介';
    context.data.humanIntro = '手写简介';
    pageConfig.applyVideo.call(
      context,
      video({
        autoTitle: 'NS2611021636327571',
        humanTitle: '',
        autoIntro: '另一版生成稿',
        humanIntro: '',
        ingest: { ...video().ingest, phase: 'running' },
      }),
      'b1',
      { keepEdits: true },
    );
    assert.equal(context.data.titleText, '手改名称');
    assert.equal(context.data.introText, '手写简介');
  });

  it('点封面从相册选图，裁剪确认后上传并保存，取消裁剪不改原封面', async () => {
    const calls = [];
    const originalWx = global.wx;
    global.wx = {
      chooseMedia(options) {
        calls.push({ type: 'chooseMedia', options });
        options.success({
          tempFiles: [{ tempFilePath: 'wxfile://album.jpg' }],
        });
      },
      navigateTo(options) {
        calls.push({ type: 'navigateTo', url: options.url });
        options.success({ eventChannel: { emit() {} } });
        options.events.done({ path: 'wxfile://crop.jpg' });
      },
      showLoading() {},
      hideLoading() {},
      showToast() {},
      cloud: {
        uploadFile() {
          calls.push({ type: 'upload' });
          return Promise.resolve({ fileID: 'cloud://custom-cover' });
        },
      },
    };
    const saved = [];
    const context = {
      data: {
        id: 'v1',
        brandId: 'b1',
        coverFileId: 'cloud://auto-cover',
        posterUrl: 'https://example.com/first-frame.jpg',
        humanTitle: '',
        autoTitle: '片头标题',
        humanIntro: '',
        autoIntro: '',
        modelName: '',
        tags: '',
        videoFileId: 'cloud://video',
      },
      setData(patch, callback) {
        this.data = { ...this.data, ...patch };
        if (callback) {
          callback();
        }
      },
      ensureSaved() {
        return Promise.resolve(this.data.id);
      },
      uploadCloudFile(kind, filePath, ext) {
        calls.push({ type: 'uploadCloudFile', kind, filePath, ext });
        return Promise.resolve('cloud://custom-cover');
      },
      persist(silent) {
        saved.push({
          silent,
          coverFileId: this.data.coverFileId,
          posterUrl: this.data.posterUrl,
        });
        return Promise.resolve(this.data.id);
      },
    };

    try {
      await pageConfig.pickCoverPhoto.call(context);
      assert.deepEqual(calls[0].options.mediaType, ['image']);
      assert.equal(calls[0].options.count, 1);
      assert.match(calls[1].url, /\/pages\/admin\/cover-crop\/cover-crop\?src=/);
      assert.match(decodeURIComponent(calls[1].url), /wxfile:\/\/album\.jpg/);
      assert.deepEqual(calls[2], {
        type: 'uploadCloudFile',
        kind: 'cover',
        filePath: 'wxfile://crop.jpg',
        ext: 'jpg',
      });
      assert.equal(context.data.coverFileId, 'cloud://custom-cover');
      assert.equal(context.data.posterUrl, 'wxfile://crop.jpg');
      assert.deepEqual(saved, [{
        silent: true,
        coverFileId: 'cloud://custom-cover',
        posterUrl: 'wxfile://crop.jpg',
      }]);

      saved.length = 0;
      context.data.coverFileId = 'cloud://auto-cover';
      context.data.posterUrl = 'https://example.com/first-frame.jpg';
      global.wx.navigateTo = (options) => {
        options.success({ eventChannel: { emit() {} } });
        options.events.cancel();
      };
      await pageConfig.pickCoverPhoto.call(context);
      assert.equal(context.data.coverFileId, 'cloud://auto-cover');
      assert.equal(context.data.posterUrl, 'https://example.com/first-frame.jpg');
      assert.equal(saved.length, 0);

      const wxml = fs.readFileSync(path.join(__dirname, 'edit.wxml'), 'utf8');
      assert.match(wxml, /bindtap="pickCoverPhoto"/);
      assert.match(wxml, /更换封面/);
    } finally {
      global.wx = originalWx;
    }
  });

  it('选文件失败时弹出接口原文，取消不提示', () => {
    const originalWx = global.wx;
    const shown = [];
    global.wx = {
      showModal(options) {
        shown.push(options);
      },
    };
    try {
      pageConfig.showPickError({ errMsg: 'chooseMessageFile:fail cancel' });
      pageConfig.showPickError({ errMsg: 'chooseMessageFile:fail' });
      assert.equal(shown.length, 1);
      assert.equal(shown[0].title, '没有选到视频');
      assert.equal(shown[0].content, 'chooseMessageFile:fail');
    } finally {
      global.wx = originalWx;
    }
  });
});
