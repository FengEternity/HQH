'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { runOnce } = require('./workerLoop');

const PLACEHOLDER_INTRO = '讲解处理中，完成后请核对简介。';

function claimedJob() {
  return {
    job: {
      _id: 'job-1',
      videoId: 'vid',
      mediaRevision: 1,
      phase: 'running',
      workerId: 'w1',
    },
    videoId: 'vid',
    mediaRevision: 1,
    videoFileId: 'cloud://v',
  };
}

function createDeps(overrides = {}) {
  const completes = [];
  return {
    completes,
    deps: {
      catalog: {
        claim: async ({ workerId }) => {
          assert.equal(workerId, 'w1');
          return claimedJob();
        },
        complete: async (payload) => {
          completes.push(payload);
        },
      },
      workerId: 'w1',
      downloadVideo: async (fileId) => {
        assert.equal(fileId, 'cloud://v');
        return '/tmp/a.mp4';
      },
      probeMedia: async () => ({
        hasAudio: true,
        videoCodec: 'h264',
        audioCodec: 'aac',
        durationSec: 3,
        needsTranscode: false,
      }),
      transcodeIfNeeded: async (localPath) => ({ path: localPath }),
      transcribe: async () => ({
        ok: true,
        segments: [{ startSec: 0, endSec: 1, text: '打开项目。' }],
        skipped: false,
      }),
      resolveAutoIntro: () => ({ grounded: false, intro: PLACEHOLDER_INTRO }),
      placeholderIntro: PLACEHOLDER_INTRO,
      now: () => 1,
      ...overrides,
    },
  };
}

describe('runOnce', () => {
  it('claim 空任务时返回 idle 且不继续处理', async () => {
    const { deps, completes } = createDeps({
      catalog: {
        claim: async () => ({ job: null }),
        complete: async (payload) => completes.push(payload),
      },
      downloadVideo: async () => {
        throw new Error('不应下载');
      },
    });

    assert.equal(await runOnce(deps), 'idle');
    assert.deepEqual(completes, []);
  });

  it('下载失败时回写稳定失败码和固定错误文案', async () => {
    const { deps, completes } = createDeps({
      downloadVideo: async () => {
        throw new Error('secret download detail');
      },
    });

    assert.equal(await runOnce(deps), 'failed');
    assert.deepEqual(completes, [
      {
        videoId: 'vid',
        mediaRevision: 1,
        outcome: 'failed',
        asr: 'failed',
        errorCode: 'DOWNLOAD_FAILED',
        errorMessage: '处理失败',
      },
    ]);
  });

  it('探测到无音轨时直接 ready/skipped 且不生成简介', async () => {
    const { deps, completes } = createDeps({
      probeMedia: async () => ({
        hasAudio: false,
        videoCodec: 'h264',
        audioCodec: '',
        durationSec: 3,
        needsTranscode: false,
      }),
      transcribe: async () => {
        throw new Error('无音轨不应转写');
      },
      resolveAutoIntro: () => {
        throw new Error('无音轨不应生成简介');
      },
    });

    assert.equal(await runOnce(deps), 'processed');
    assert.deepEqual(completes, [
      {
        videoId: 'vid',
        mediaRevision: 1,
        outcome: 'ready',
        asr: 'skipped',
        durationSec: 3,
        media: {
          hasAudio: false,
          videoCodec: 'h264',
          audioCodec: '',
        },
      },
    ]);
  });

  it('转码失败时回写 TRANSCODE_FAILED', async () => {
    const { deps, completes } = createDeps({
      probeMedia: async () => ({
        hasAudio: true,
        videoCodec: 'hevc',
        audioCodec: 'aac',
        durationSec: 3,
        needsTranscode: true,
      }),
      transcodeIfNeeded: async () => {
        throw new Error('ffmpeg details');
      },
    });

    assert.equal(await runOnce(deps), 'failed');
    assert.equal(completes[0].errorCode, 'TRANSCODE_FAILED');
    assert.equal(completes[0].errorMessage, '处理失败');
  });

  it('转码成功在同一任务完成并携带新 fileId', async () => {
    let claimCount = 0;
    const { deps, completes } = createDeps({
      catalog: {
        claim: async () => {
          claimCount += 1;
          return claimedJob();
        },
        complete: async (payload) => completes.push(payload),
      },
      probeMedia: async () => ({
        hasAudio: true,
        videoCodec: 'hevc',
        audioCodec: 'opus',
        durationSec: 3,
        needsTranscode: true,
      }),
      transcodeIfNeeded: async () => ({
        path: '/tmp/a-transcoded.mp4',
        uploadedFileId: 'cloud://transcoded',
      }),
    });

    assert.equal(await runOnce(deps), 'processed');
    assert.equal(claimCount, 1);
    assert.equal(completes[0].mediaRevision, 1);
    assert.equal(completes[0].transcodedVideoFileId, 'cloud://transcoded');
  });

  it('ASR 失败时回写 ASR_FAILED 且不生成简介', async () => {
    const { deps, completes } = createDeps({
      transcribe: async () => ({ ok: false, segments: [], skipped: false }),
      resolveAutoIntro: () => {
        throw new Error('失败转写不应生成简介');
      },
    });

    assert.equal(await runOnce(deps), 'failed');
    assert.equal(completes[0].errorCode, 'ASR_FAILED');
    assert.equal(completes[0].errorMessage, '处理失败');
  });

  it('有取证简介时携带字幕和 intro 完成任务', async () => {
    const segments = [{ startSec: 0, endSec: 1, text: '打开项目。' }];
    const { deps, completes } = createDeps({
      transcribe: async () => ({ ok: true, segments, skipped: false }),
      resolveAutoIntro: ({ transcriptSegments, placeholderIntro }) => {
        assert.deepEqual(transcriptSegments, segments);
        assert.equal(placeholderIntro, PLACEHOLDER_INTRO);
        return { grounded: true, intro: '打开项目。' };
      },
    });

    assert.equal(await runOnce(deps), 'processed');
    assert.deepEqual(completes[0].transcriptSegments, segments);
    assert.equal(completes[0].intro, '打开项目。');
  });

  it('未取证简介仍 ready 但不覆盖 intro', async () => {
    const { deps, completes } = createDeps();

    assert.equal(await runOnce(deps), 'processed');
    assert.equal(completes[0].outcome, 'ready');
    assert.equal(Object.hasOwn(completes[0], 'intro'), false);
  });

  it('未分类异常回写 INTERNAL', async () => {
    const { deps, completes } = createDeps({
      probeMedia: async () => {
        throw new Error('unexpected probe output');
      },
    });

    assert.equal(await runOnce(deps), 'failed');
    assert.equal(completes[0].errorCode, 'INTERNAL');
    assert.equal(completes[0].errorMessage, '处理失败');
  });
});
