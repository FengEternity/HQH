'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PLACEHOLDER_INTRO } = require('./videoIngest');

let actions = {};
try {
  actions = require('./videoIngestActions');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') {
    throw error;
  }
}

const { applyCompleteToVideo, buildUpsertIngestPatch } = actions;

function readyVideo(overrides = {}) {
  return {
    videoFileId: 'cloud://old',
    coverFileId: '',
    intro: '旧自动简介',
    transcriptSegments: [{ startSec: 0, endSec: 1, text: '旧词' }],
    transcript: '旧词',
    durationSec: 1,
    media: { videoCodec: 'h264', audioCodec: 'aac', hasAudio: true },
    ingest: {
      phase: 'ready',
      mediaRevision: 1,
      videoFileId: 'cloud://old',
      asr: 'ready',
      introSource: 'auto',
      errorCode: '',
      errorMessage: '',
      queuedAt: 1,
      startedAt: 2,
      finishedAt: 3,
      attempt: 1,
    },
    ...overrides,
  };
}

describe('buildUpsertIngestPatch', () => {
  it('clears transcript and bumps revision when admin replaces the file', () => {
    assert.equal(typeof buildUpsertIngestPatch, 'function');
    const patch = buildUpsertIngestPatch({
      prevData: readyVideo(),
      nextVideoFileId: 'cloud://new',
      nextIntro: PLACEHOLDER_INTRO,
      now: 10,
    });

    assert.equal(patch.clearTranscript, true);
    assert.equal(patch.enqueue, true);
    assert.equal(patch.ingest.mediaRevision, 2);
    assert.equal(patch.ingest.videoFileId, 'cloud://new');
    assert.equal(patch.ingest.phase, 'queued');
  });
});

describe('applyCompleteToVideo', () => {
  it('applies grounded worker output and keeps revision for transcoded file', () => {
    assert.equal(typeof applyCompleteToVideo, 'function');
    const patch = applyCompleteToVideo({
      prevData: readyVideo({
        intro: PLACEHOLDER_INTRO,
        ingest: {
          ...readyVideo().ingest,
          phase: 'running',
          introSource: 'placeholder',
        },
      }),
      complete: {
        mediaRevision: 1,
        outcome: 'ready',
        asr: 'ready',
        intro: '新的自动简介',
        transcriptSegments: [{ startSec: 0, endSec: 1.24, text: '新词' }],
        durationSec: 1.26,
        media: { videoCodec: 'H264', audioCodec: 'AAC', hasAudio: true },
        coverFileId: 'cloud://cover',
        transcodedVideoFileId: 'cloud://transcoded',
      },
      now: 20,
    });

    assert.equal(patch.ingest.phase, 'ready');
    assert.equal(patch.ingest.mediaRevision, 1);
    assert.equal(patch.ingest.videoFileId, 'cloud://transcoded');
    assert.equal(patch.videoFileId, 'cloud://transcoded');
    assert.equal(patch.intro, '新的自动简介');
    assert.deepEqual(patch.transcriptSegments, [
      { startSec: 0, endSec: 1.24, text: '新词' },
    ]);
    assert.equal(patch.transcript, '新词');
    assert.equal(patch.durationSec, 1.3);
    assert.deepEqual(patch.media, {
      videoCodec: 'h264',
      audioCodec: 'aac',
      hasAudio: true,
    });
    assert.equal(patch.coverFileId, 'cloud://cover');
  });

  it('preserves human content and ignores fake segments when ASR is skipped', () => {
    const previous = readyVideo({
      coverFileId: 'cloud://human-cover',
      intro: '人工简介',
      ingest: {
        ...readyVideo().ingest,
        phase: 'running',
        introSource: 'human',
      },
    });
    const patch = applyCompleteToVideo({
      prevData: previous,
      complete: {
        mediaRevision: 1,
        outcome: 'ready',
        asr: 'skipped',
        intro: '不应覆盖',
        transcriptSegments: [{ startSec: 0, endSec: 1, text: '伪字幕' }],
        coverFileId: 'cloud://worker-cover',
      },
      now: 30,
    });

    assert.equal(patch.intro, '人工简介');
    assert.deepEqual(patch.transcriptSegments, previous.transcriptSegments);
    assert.equal(patch.transcript, '旧词');
    assert.equal(patch.coverFileId, 'cloud://human-cover');
    assert.equal(patch.ingest.asr, 'skipped');
  });

  it('rejects stale completion before constructing a patch', () => {
    assert.throws(
      () =>
        applyCompleteToVideo({
          prevData: readyVideo(),
          complete: { mediaRevision: 0, outcome: 'ready', asr: 'ready' },
          now: 40,
        }),
      (error) => error.code === 'BAD_INPUT',
    );
  });
});
