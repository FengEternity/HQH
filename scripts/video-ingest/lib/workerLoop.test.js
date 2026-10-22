'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { fitSegmentsToDuration, runOnce } = require('./workerLoop');

const PLACEHOLDER_INTRO = '讲解处理中，完成后请核对简介。';

function playback(overrides = {}) {
  return {
    videoCodec: 'h264',
    profile: 'Main',
    pixelFormat: 'yuv420p',
    width: 1280,
    height: 720,
    frameRate: 30,
    hasBFrames: false,
    maxKeyframeGapSec: 2,
    fastStart: true,
    hasAudio: true,
    audioCodec: 'aac',
    compliant: true,
    ...overrides,
  };
}

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
    title: '千寻仪器数据导入',
    brandName: '千寻',
  };
}

function createDeps(overrides = {}) {
  const completes = [];
  const deletedFileIds = [];
  return {
    completes,
    deletedFileIds,
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
        playback: playback(),
      }),
      transcodeIfNeeded: async (localPath) => ({ path: localPath }),
      transcribe: async () => ({
        ok: true,
        segments: [{ startSec: 0, endSec: 1, text: '打开项目。' }],
        skipped: false,
      }),
      summarizeIntro: () => ({ grounded: false, intro: PLACEHOLDER_INTRO }),
      placeholderIntro: PLACEHOLDER_INTRO,
      now: () => 1,
      deleteCloudFiles: async (fileIds) => {
        deletedFileIds.push(...fileIds);
      },
      warn: () => {},
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
        throw new Error(
          'https://storage.invalid/private-token /tmp/private/input.mp4 secret-value',
        );
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

  it('可播编码无音轨时不转码并直接 ready/skipped', async () => {
    const { deps, completes } = createDeps({
      probeMedia: async () => ({
        hasAudio: false,
        videoCodec: 'h264',
        audioCodec: '',
        durationSec: 3,
        needsTranscode: false,
        playback: playback({ hasAudio: false, audioCodec: '' }),
      }),
      transcodeIfNeeded: async () => {
        throw new Error('可播编码不应转码');
      },
      transcribe: async () => {
        throw new Error('无音轨不应转写');
      },
      summarizeIntro: () => {
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
          playback: playback({ hasAudio: false, audioCodec: '' }),
        },
      },
    ]);
  });

  it('没有封面时从最终播放文件生成封面并随 ready 回写', async () => {
    const generatedFrom = [];
    const { deps, completes } = createDeps({
      probeMedia: async () => ({
        hasAudio: false,
        videoCodec: 'h264',
        audioCodec: '',
        durationSec: 3,
        needsTranscode: false,
        playback: playback({ hasAudio: false, audioCodec: '' }),
      }),
      createCover: async (mediaPath, probe) => {
        generatedFrom.push([mediaPath, probe.durationSec]);
        return 'cloud://auto-cover';
      },
    });

    assert.equal(await runOnce(deps), 'processed');
    assert.deepEqual(generatedFrom, [['/tmp/a.mp4', 3]]);
    assert.equal(completes[0].coverFileId, 'cloud://auto-cover');
  });

  it('已有封面时不再生成自动封面', async () => {
    const { deps, completes } = createDeps({
      catalog: {
        claim: async () => ({ ...claimedJob(), coverFileId: 'cloud://human-cover' }),
        complete: async (payload) => completes.push(payload),
      },
      createCover: async () => {
        throw new Error('已有封面时不应调用');
      },
    });

    assert.equal(await runOnce(deps), 'processed');
    assert.equal(completes[0].coverFileId, undefined);
  });

  it('自动封面失败不阻断转写和任务完成', async () => {
    const warnings = [];
    const { deps, completes } = createDeps({
      createCover: async () => {
        throw new Error('ffmpeg cover failed /tmp/private.mp4');
      },
      warn: (message) => warnings.push(message),
    });

    assert.equal(await runOnce(deps), 'processed');
    assert.equal(completes[0].asr, 'ready');
    assert.equal(completes[0].coverFileId, undefined);
    assert.deepEqual(warnings, ['自动封面生成失败']);
  });

  it('HEVC 无音轨先转码再 skipped 且不运行 ASR', async () => {
    const probes = [];
    const { deps, completes } = createDeps({
      probeMedia: async (mediaPath) => {
        probes.push(mediaPath);
        if (mediaPath === '/tmp/a.mp4') {
          return {
            hasAudio: false,
            videoCodec: 'hevc',
            audioCodec: '',
            durationSec: 3,
            needsTranscode: true,
            playback: playback({
              videoCodec: 'hevc',
              hasAudio: false,
              audioCodec: '',
              compliant: false,
            }),
          };
        }
        return {
          hasAudio: false,
          videoCodec: 'h264',
          audioCodec: '',
          durationSec: 3,
          needsTranscode: false,
          playback: playback({ hasAudio: false, audioCodec: '' }),
        };
      },
      transcodeIfNeeded: async () => ({
        path: '/tmp/a-transcoded.mp4',
        uploadedFileId: 'cloud://transcoded-no-audio',
      }),
      transcribe: async () => {
        throw new Error('无音轨不应转写');
      },
    });

    assert.equal(await runOnce(deps), 'processed');
    assert.deepEqual(probes, ['/tmp/a.mp4', '/tmp/a-transcoded.mp4']);
    assert.deepEqual(completes[0], {
      videoId: 'vid',
      mediaRevision: 1,
      outcome: 'ready',
      asr: 'skipped',
      durationSec: 3,
      media: {
        hasAudio: false,
        videoCodec: 'h264',
        audioCodec: '',
        playback: playback({ hasAudio: false, audioCodec: '' }),
      },
      transcodedVideoFileId: 'cloud://transcoded-no-audio',
    });
  });

  it('ffmpeg 超时时回写 TRANSCODE_FAILED', async () => {
    const timeout = Object.assign(new Error('ffmpeg timeout'), {
      code: 'ETIMEDOUT',
    });
    const { deps, completes } = createDeps({
      probeMedia: async () => ({
        hasAudio: true,
        videoCodec: 'hevc',
        audioCodec: 'aac',
        durationSec: 3,
        needsTranscode: true,
        playback: playback({ videoCodec: 'hevc', compliant: false }),
      }),
      transcodeIfNeeded: async () => {
        throw timeout;
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
      probeMedia: async (mediaPath) =>
        mediaPath === '/tmp/a.mp4'
          ? {
              hasAudio: true,
              videoCodec: 'hevc',
              audioCodec: 'opus',
              durationSec: 3,
              needsTranscode: true,
              playback: playback({
                videoCodec: 'hevc',
                audioCodec: 'opus',
                compliant: false,
              }),
            }
          : {
              hasAudio: true,
              videoCodec: 'h264',
              audioCodec: 'aac',
              durationSec: 3,
              needsTranscode: false,
              playback: playback(),
            },
      transcodeIfNeeded: async () => ({
        path: '/tmp/a-transcoded.mp4',
        uploadedFileId: 'cloud://transcoded',
      }),
    });

    assert.equal(await runOnce(deps), 'processed');
    assert.equal(claimCount, 1);
    assert.equal(completes[0].mediaRevision, 1);
    assert.equal(completes[0].transcodedVideoFileId, 'cloud://transcoded');
    assert.deepEqual(completes[0].media, {
      hasAudio: true,
      videoCodec: 'h264',
      audioCodec: 'aac',
      playback: playback(),
    });
  });

  it('转码后二次检查仍不合格时回写失败并删除新产物', async () => {
    const deletedFileIds = [];
    const { deps, completes } = createDeps({
      probeMedia: async (mediaPath) =>
        mediaPath === '/tmp/a.mp4'
          ? {
              hasAudio: true,
              videoCodec: 'hevc',
              audioCodec: 'aac',
              durationSec: 3,
              needsTranscode: true,
              playback: playback({ videoCodec: 'hevc', compliant: false }),
            }
          : {
              hasAudio: true,
              videoCodec: 'h264',
              audioCodec: 'aac',
              durationSec: 3,
              needsTranscode: true,
              playback: playback({ maxKeyframeGapSec: 10, compliant: false }),
            },
      transcodeIfNeeded: async () => ({
        path: '/tmp/a-transcoded.mp4',
        uploadedFileId: 'cloud://bad-transcoded',
      }),
      deleteCloudFiles: async (fileIds) => deletedFileIds.push(...fileIds),
    });

    assert.equal(await runOnce(deps), 'failed');
    assert.equal(completes[0].errorCode, 'TRANSCODE_FAILED');
    assert.deepEqual(deletedFileIds, ['cloud://bad-transcoded']);
  });

  it('原片合格时使用原 fileId 且不上传或删除文件', async () => {
    let transcodeCount = 0;
    const { deps, completes, deletedFileIds } = createDeps({
      transcodeIfNeeded: async () => {
        transcodeCount += 1;
        return { path: '/tmp/unexpected.mp4', uploadedFileId: 'cloud://unexpected' };
      },
    });

    assert.equal(await runOnce(deps), 'processed');
    assert.equal(transcodeCount, 0);
    assert.equal(Object.hasOwn(completes[0], 'transcodedVideoFileId'), false);
    assert.deepEqual(deletedFileIds, []);
  });

  it('转码成功回写后删除原始云文件', async () => {
    const deletedFileIds = [];
    const { deps } = createDeps({
      probeMedia: async (mediaPath) =>
        mediaPath === '/tmp/a.mp4'
          ? {
              hasAudio: true,
              videoCodec: 'hevc',
              audioCodec: 'aac',
              durationSec: 3,
              needsTranscode: true,
              playback: playback({ videoCodec: 'hevc', compliant: false }),
            }
          : {
              hasAudio: true,
              videoCodec: 'h264',
              audioCodec: 'aac',
              durationSec: 3,
              needsTranscode: false,
              playback: playback(),
            },
      transcodeIfNeeded: async () => ({
        path: '/tmp/a-transcoded.mp4',
        uploadedFileId: 'cloud://transcoded',
      }),
      deleteCloudFiles: async (fileIds) => deletedFileIds.push(...fileIds),
    });

    assert.equal(await runOnce(deps), 'processed');
    assert.deepEqual(deletedFileIds, ['cloud://v']);
  });

  it('原文件删除失败只记录受控警告且不反转成功回写', async () => {
    const warnings = [];
    const { deps, completes } = createDeps({
      probeMedia: async (mediaPath) =>
        mediaPath === '/tmp/a.mp4'
          ? {
              hasAudio: false,
              videoCodec: 'hevc',
              audioCodec: '',
              durationSec: 3,
              needsTranscode: true,
              playback: playback({
                videoCodec: 'hevc',
                hasAudio: false,
                audioCodec: '',
                compliant: false,
              }),
            }
          : {
              hasAudio: false,
              videoCodec: 'h264',
              audioCodec: '',
              durationSec: 3,
              needsTranscode: false,
              playback: playback({ hasAudio: false, audioCodec: '' }),
            },
      transcodeIfNeeded: async () => ({
        path: '/tmp/a-transcoded.mp4',
        uploadedFileId: 'cloud://transcoded',
      }),
      deleteCloudFiles: async () => {
        throw new Error('cloud://v private-url');
      },
      warn: (message) => warnings.push(message),
    });

    assert.equal(await runOnce(deps), 'processed');
    assert.equal(completes.length, 1);
    assert.deepEqual(warnings, ['云文件清理失败']);
    assert.equal(warnings[0].includes('cloud://'), false);
  });

  it('转码后 ASR 失败时保留新产物并删除原始文件', async () => {
    const deletedFileIds = [];
    const completes = [];
    const { deps } = createDeps({
      catalog: {
        claim: async () => claimedJob(),
        complete: async (payload) => {
          completes.push(payload);
        },
      },
      probeMedia: async (mediaPath) =>
        mediaPath === '/tmp/a.mp4'
          ? {
              hasAudio: true,
              videoCodec: 'hevc',
              audioCodec: 'aac',
              durationSec: 3,
              needsTranscode: true,
              playback: playback({ videoCodec: 'hevc', compliant: false }),
            }
          : {
              hasAudio: true,
              videoCodec: 'h264',
              audioCodec: 'aac',
              durationSec: 3,
              needsTranscode: false,
              playback: playback(),
            },
      transcodeIfNeeded: async () => ({
        path: '/tmp/a-transcoded.mp4',
        uploadedFileId: 'cloud://transcoded',
      }),
      transcribe: async () => ({ ok: false }),
      deleteCloudFiles: async (fileIds) => deletedFileIds.push(...fileIds),
    });

    assert.equal(await runOnce(deps), 'processed');
    assert.equal(completes[0].outcome, 'ready');
    assert.equal(completes[0].asr, 'failed');
    assert.equal(completes[0].transcodedVideoFileId, 'cloud://transcoded');
    assert.deepEqual(deletedFileIds, ['cloud://v']);
  });

  it('转码后 ready 回写失败时删除新视频和自动封面并保留原始文件', async () => {
    const completes = [];
    const deletedFileIds = [];
    const { deps } = createDeps({
      catalog: {
        claim: async () => claimedJob(),
        complete: async (payload) => {
          completes.push(payload);
          if (payload.outcome === 'ready') {
            throw new Error('云端写库失败');
          }
        },
      },
      probeMedia: async (mediaPath) =>
        mediaPath === '/tmp/a.mp4'
          ? {
              hasAudio: true,
              videoCodec: 'hevc',
              audioCodec: 'aac',
              durationSec: 3,
              needsTranscode: true,
              playback: playback({ videoCodec: 'hevc', compliant: false }),
            }
          : {
              hasAudio: true,
              videoCodec: 'h264',
              audioCodec: 'aac',
              durationSec: 3,
              needsTranscode: false,
              playback: playback(),
            },
      transcodeIfNeeded: async () => ({
        path: '/tmp/a-transcoded.mp4',
        uploadedFileId: 'cloud://transcoded',
      }),
      createCover: async () => 'cloud://auto-cover',
      deleteCloudFiles: async (fileIds) => deletedFileIds.push(...fileIds),
    });

    assert.equal(await runOnce(deps), 'failed');
    assert.equal(completes.at(-1).errorCode, 'INTERNAL');
    assert.deepEqual(deletedFileIds, ['cloud://transcoded', 'cloud://auto-cover']);
  });

  it('Python 转写超时时回写 ASR_FAILED 且不生成简介', async () => {
    const timeout = Object.assign(new Error('python timeout'), {
      code: 'ETIMEDOUT',
    });
    const { deps, completes } = createDeps({
      transcribe: async () => {
        throw timeout;
      },
      summarizeIntro: () => {
        throw new Error('失败转写不应生成简介');
      },
    });

    assert.equal(await runOnce(deps), 'processed');
    assert.equal(completes[0].outcome, 'ready');
    assert.equal(completes[0].asr, 'failed');
    assert.equal(completes[0].errorMessage, '转写失败，播放文件已更新');
    assert.equal(Object.hasOwn(completes[0], 'intro'), false);
    assert.equal(Object.hasOwn(completes[0], 'errorCode'), false);
  });

  it('转写失败时保留已上传的合格文件并删除原文件', async () => {
    const deletedFileIds = [];
    let probes = 0;
    const { deps, completes } = createDeps({
      probeMedia: async () => {
        probes += 1;
        if (probes === 1) {
          return {
            hasAudio: true,
            durationSec: 3,
            needsTranscode: true,
            playback: playback({ compliant: false }),
          };
        }
        return {
          hasAudio: true,
          durationSec: 3,
          needsTranscode: false,
          playback: playback(),
        };
      },
      transcodeIfNeeded: async () => ({
        path: '/tmp/a-transcoded.mp4',
        uploadedFileId: 'cloud://transcoded',
      }),
      transcribe: async () => {
        throw new Error('asr down');
      },
      deleteCloudFiles: async (fileIds) => deletedFileIds.push(...fileIds),
    });

    assert.equal(await runOnce(deps), 'processed');
    assert.equal(completes[0].transcodedVideoFileId, 'cloud://transcoded');
    assert.deepEqual(deletedFileIds, ['cloud://v']);
  });

  it('有取证简介时携带字幕和 intro 完成任务', async () => {
    const segments = [{ startSec: 0, endSec: 1, text: '打开项目。' }];
    const { deps, completes } = createDeps({
      transcribe: async () => ({ ok: true, segments, skipped: false }),
      summarizeIntro: ({ transcriptSegments, placeholderIntro, title, brandName }) => {
        assert.deepEqual(transcriptSegments, segments);
        assert.equal(placeholderIntro, PLACEHOLDER_INTRO);
        assert.equal(title, '千寻仪器数据导入');
        assert.equal(brandName, '千寻');
        return { grounded: true, intro: '打开项目。' };
      },
    });

    assert.equal(await runOnce(deps), 'processed');
    assert.deepEqual(completes[0].transcriptSegments, segments);
    assert.equal(completes[0].intro, '打开项目。');
  });

  it('闸门拒绝的简介仍然回写，并带上原因', async () => {
    const segments = [{ startSec: 0, endSec: 1, text: '打开项目。' }];
    const notes = [];
    const { deps, completes } = createDeps({
      catalog: {
        claim: async () => claimedJob(),
        noteIntro: async (payload) => {
          notes.push(payload);
        },
        complete: async (payload) => {
          completes.push(payload);
        },
      },
      transcribe: async () => ({ ok: true, segments, skipped: false }),
      summarizeIntro: async () => ({
        grounded: false,
        gateOk: false,
        gateReason: 'term 四参数',
        intro: '华测RTK支持四参数计算。',
      }),
    });

    assert.equal(await runOnce(deps), 'processed');
    assert.equal(completes[0].intro, '华测RTK支持四参数计算。');
    assert.deepEqual(completes[0].introGate, { ok: false, reason: 'term 四参数' });
    assert.equal(notes.length, 0);
  });

  it('未通过的腾讯云简介也会提前回写', async () => {
    const notes = [];
    const { deps, completes } = createDeps({
      catalog: {
        claim: async () => claimedJob(),
        noteIntro: async (payload) => {
          notes.push(payload);
        },
        complete: async (payload) => {
          completes.push(payload);
        },
      },
      recognizeSpeech: async () => ({
        grounded: false,
        gateOk: false,
        gateReason: 'term 四参数',
        intro: '华测RTK支持四参数计算。',
        segments: [{ startSec: 0, endSec: 1, text: '打开项目。' }],
      }),
      summarizeIntro: async () => ({ grounded: false, intro: PLACEHOLDER_INTRO }),
    });

    assert.equal(await runOnce(deps), 'processed');
    assert.equal(notes[0].intro, '华测RTK支持四参数计算。');
    assert.deepEqual(notes[0].introGate, { ok: false, reason: 'term 四参数' });
    assert.equal(completes[0].intro, '华测RTK支持四参数计算。');
    assert.deepEqual(completes[0].introGate, { ok: false, reason: 'term 四参数' });
  });

  it('摘要失败时仍回写字幕且不带 intro', async () => {
    const segments = [{ startSec: 0, endSec: 1, text: '打开项目。' }];
    const { deps, completes } = createDeps({
      transcribe: async () => ({ ok: true, segments, skipped: false }),
      summarizeIntro: async () => {
        throw new Error('llama missing');
      },
    });

    assert.equal(await runOnce(deps), 'processed');
    assert.equal(completes[0].asr, 'ready');
    assert.equal(completes[0].outcome, 'ready');
    assert.deepEqual(completes[0].transcriptSegments, segments);
    assert.equal(Object.hasOwn(completes[0], 'intro'), false);
  });

  it('未取证简介仍 ready 但不覆盖 intro', async () => {
    const { deps, completes } = createDeps();

    assert.equal(await runOnce(deps), 'processed');
    assert.equal(completes[0].outcome, 'ready');
    assert.equal(Object.hasOwn(completes[0], 'intro'), false);
  });

  it('ready 回写失败后补一次 INTERNAL 失败回写，让云端能落到 failed', async () => {
    const completes = [];
    const { deps } = createDeps({
      catalog: {
        claim: async () => claimedJob(),
        complete: async (payload) => {
          completes.push(payload);
          if (completes.length === 1) {
            throw new Error('云端写库失败');
          }
        },
      },
    });

    assert.equal(await runOnce(deps), 'failed');
    assert.equal(completes.length, 2);
    assert.equal(completes[0].outcome, 'ready');
    assert.deepEqual(completes[1], {
      videoId: 'vid',
      mediaRevision: 1,
      outcome: 'failed',
      asr: 'failed',
      errorCode: 'INTERNAL',
      errorMessage: '处理失败',
    });
  });

  it('ffprobe 超时时回写 INTERNAL', async () => {
    const timeout = Object.assign(new Error('ffprobe timeout'), {
      code: 'ETIMEDOUT',
    });
    const { deps, completes } = createDeps({
      probeMedia: async () => {
        throw timeout;
      },
    });

    assert.equal(await runOnce(deps), 'failed');
    assert.equal(completes[0].errorCode, 'INTERNAL');
    assert.equal(completes[0].errorMessage, '处理失败');
  });

  it('腾讯云简介在转码前写回，并且不再走本地转写', async () => {
    const notes = [];
    let transcribed = false;
    let transcoded = false;
    let notedBeforeTranscode = false;
    let probes = 0;
    const { deps, completes } = createDeps({
      catalog: {
        claim: async () => claimedJob(),
        noteIntro: async (payload) => {
          notedBeforeTranscode = transcoded === false;
          notes.push(payload);
        },
        complete: async (payload) => {
          completes.push(payload);
        },
      },
      probeMedia: async () => {
        probes += 1;
        if (probes === 1) {
          return {
            hasAudio: true,
            videoCodec: 'hevc',
            audioCodec: 'aac',
            durationSec: 3,
            needsTranscode: true,
            playback: playback({ videoCodec: 'hevc', compliant: false }),
          };
        }
        return {
          hasAudio: true,
          videoCodec: 'h264',
          audioCodec: 'aac',
          durationSec: 3,
          needsTranscode: false,
          playback: playback(),
        };
      },
      transcodeIfNeeded: async (localPath) => {
        transcoded = true;
        return { path: localPath, uploadedFileId: 'cloud://processed' };
      },
      transcribe: async () => {
        transcribed = true;
        return { ok: true, segments: [], skipped: false };
      },
      recognizeSpeech: async () => ({
        grounded: true,
        intro: '千寻本期讲解如何打开项目。',
        segments: [{ startSec: 0, endSec: 1, text: '打开项目。' }],
      }),
    });

    assert.equal(await runOnce(deps), 'processed');
    assert.equal(notes[0].intro, '千寻本期讲解如何打开项目。');
    assert.equal(notedBeforeTranscode, true);
    assert.equal(transcoded, true);
    assert.equal(transcribed, false);
    assert.equal(completes[0].intro, '千寻本期讲解如何打开项目。');
  });

  it('腾讯云句子结束时间超出片长时裁到片长再回写', async () => {
    const { deps, completes } = createDeps({
      recognizeSpeech: async () => ({
        grounded: true,
        intro: '千寻本期讲解如何打开项目。',
        segments: [{ startSec: 0, endSec: 3.2, text: '打开项目。' }],
      }),
    });

    assert.equal(await runOnce(deps), 'processed');
    assert.equal(completes[0].outcome, 'ready');
    assert.deepEqual(completes[0].transcriptSegments, [
      { startSec: 0, endSec: 3, text: '打开项目。' },
    ]);
  });

  it('把句子结束时间裁到一位小数的片长', () => {
    assert.deepEqual(
      fitSegmentsToDuration([{ startSec: 0, endSec: 12.36, text: '打开项目。' }], 12.31),
      [{ startSec: 0, endSec: 12.3, text: '打开项目。' }],
    );
  });

  it('句子乱序时先按开始时间排好', () => {
    assert.deepEqual(
      fitSegmentsToDuration([
        { startSec: 2, endSec: 3, text: '后一句' },
        { startSec: 0, endSec: 1, text: '前一句' },
      ], 3),
      [
        { startSec: 0, endSec: 1, text: '前一句' },
        { startSec: 2, endSec: 3, text: '后一句' },
      ],
    );
  });
});
