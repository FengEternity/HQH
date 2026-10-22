'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  PLACEHOLDER_INTRO,
  normalizeIngest,
  isIngestBusy,
  isOperatorIntroEdit,
  planAdminSave,
  planWorkerComplete,
  planRunningIntro,
  confirmOperatorIntro,
  resolveNextVideoFileId,
} = require('./videoIngest');

describe('normalizeIngest', () => {
  it('treats missing ingest as idle', () => {
    const ingest = normalizeIngest(undefined);
    assert.equal(ingest.phase, 'idle');
    assert.equal(ingest.mediaRevision, 0);
    assert.equal(PLACEHOLDER_INTRO, '讲解处理中，完成后请核对简介。');
  });
});

describe('planAdminSave', () => {
  it('enqueues without clearing transcript when videoFileId first appears', () => {
    const out = planAdminSave({
      prevData: null,
      nextVideoFileId: 'cloud://v1',
      nextIntro: PLACEHOLDER_INTRO,
      now: 1000,
    });
    assert.equal(out.enqueue, true);
    assert.equal(out.clearTranscript, false);
    assert.equal(out.clearPlayback, false);
    assert.equal(out.ingest.phase, 'queued');
    assert.equal(out.ingest.mediaRevision, 1);
    assert.equal(out.ingest.videoFileId, 'cloud://v1');
    assert.equal(out.ingest.asr, 'pending');
    assert.equal(out.ingest.introSource, 'placeholder');
    assert.equal(out.ingest.queuedAt, 1000);
    assert.equal(out.ingest.attempt, 1);
  });

  it('does not enqueue when videoFileId is unchanged', () => {
    const prev = {
      videoFileId: 'cloud://v1',
      ingest: {
        phase: 'ready',
        mediaRevision: 2,
        videoFileId: 'cloud://v1',
        asr: 'ready',
        introSource: 'auto',
        errorCode: '',
        errorMessage: '',
        queuedAt: 1,
        startedAt: 2,
        finishedAt: 3,
        attempt: 1,
      },
    };
    const out = planAdminSave({
      prevData: prev,
      nextVideoFileId: 'cloud://v1',
      nextIntro: '点击测量。',
      now: 2000,
    });
    assert.equal(out.enqueue, false);
    assert.equal(out.clearTranscript, false);
    assert.equal(out.ingest.phase, 'ready');
    assert.equal(out.ingest.introSource, 'human');
    assert.equal(out.ingest.mediaRevision, 2);
  });

  it('marks human intro even while running, without bumping revision', () => {
    const prev = {
      videoFileId: 'cloud://v1',
      intro: PLACEHOLDER_INTRO,
      ingest: {
        phase: 'running',
        mediaRevision: 1,
        videoFileId: 'cloud://v1',
        asr: 'pending',
        introSource: 'placeholder',
        errorCode: '',
        errorMessage: '',
        queuedAt: 1,
        startedAt: 2,
        finishedAt: 0,
        attempt: 1,
      },
    };
    const out = planAdminSave({
      prevData: prev,
      nextVideoFileId: 'cloud://v1',
      nextIntro: '人手写的步骤。',
      now: 3000,
    });
    assert.equal(out.enqueue, false);
    assert.equal(out.ingest.phase, 'running');
    assert.equal(out.ingest.introSource, 'human');
  });

  it('replacing the file bumps revision, clears transcript, and requeues', () => {
    const prev = {
      videoFileId: 'cloud://old',
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
    };
    const out = planAdminSave({
      prevData: prev,
      nextVideoFileId: 'cloud://new',
      nextIntro: '旧简介',
      now: 4000,
    });
    assert.equal(out.enqueue, true);
    assert.equal(out.clearTranscript, true);
    assert.equal(out.clearPlayback, true);
    assert.equal(out.ingest.mediaRevision, 2);
    assert.equal(out.ingest.videoFileId, 'cloud://new');
    assert.equal(out.ingest.phase, 'queued');
    assert.equal(out.ingest.asr, 'pending');
    assert.equal(out.ingest.introSource, 'placeholder');
  });

  it('keeps auto introSource when nextIntro unchanged and non-placeholder', () => {
    const prev = {
      videoFileId: 'cloud://v1',
      intro: '点击测量。',
      ingest: {
        phase: 'ready',
        mediaRevision: 1,
        videoFileId: 'cloud://v1',
        asr: 'ready',
        introSource: 'auto',
        errorCode: '',
        errorMessage: '',
        queuedAt: 1,
        startedAt: 2,
        finishedAt: 3,
        attempt: 1,
      },
    };
    const out = planAdminSave({
      prevData: prev,
      nextVideoFileId: 'cloud://v1',
      nextIntro: '点击测量。',
      now: 5000,
    });
    assert.equal(out.enqueue, false);
    assert.equal(out.ingest.introSource, 'auto');
  });

  it('does not mark human when intro unchanged', () => {
    const prev = {
      videoFileId: 'cloud://v1',
      intro: '点击测量。',
      ingest: {
        phase: 'ready',
        mediaRevision: 1,
        videoFileId: 'cloud://v1',
        asr: 'ready',
        introSource: 'auto',
        errorCode: '',
        errorMessage: '',
        queuedAt: 1,
        startedAt: 2,
        finishedAt: 3,
        attempt: 1,
      },
    };
    const out = planAdminSave({
      prevData: prev,
      nextVideoFileId: 'cloud://v1',
      nextIntro: '点击测量。',
      now: 5000,
    });
    assert.equal(out.ingest.introSource, 'auto');
  });

  it('does not mark human when saving placeholder intro', () => {
    const prev = {
      videoFileId: 'cloud://v1',
      intro: PLACEHOLDER_INTRO,
      ingest: {
        phase: 'queued',
        mediaRevision: 1,
        videoFileId: 'cloud://v1',
        asr: 'pending',
        introSource: 'placeholder',
        errorCode: '',
        errorMessage: '',
        queuedAt: 1,
        startedAt: 0,
        finishedAt: 0,
        attempt: 1,
      },
    };
    const out = planAdminSave({
      prevData: prev,
      nextVideoFileId: 'cloud://v1',
      nextIntro: PLACEHOLDER_INTRO,
      now: 5000,
    });
    assert.equal(out.ingest.introSource, 'placeholder');
  });

  it('does not mark human when nextIntro is omitted', () => {
    const prev = {
      videoFileId: 'cloud://v1',
      intro: PLACEHOLDER_INTRO,
      ingest: {
        phase: 'running',
        mediaRevision: 1,
        videoFileId: 'cloud://v1',
        asr: 'pending',
        introSource: 'placeholder',
        errorCode: '',
        errorMessage: '',
        queuedAt: 1,
        startedAt: 2,
        finishedAt: 0,
        attempt: 1,
      },
    };
    const out = planAdminSave({
      prevData: prev,
      nextVideoFileId: 'cloud://v1',
      now: 6000,
    });
    assert.equal(out.ingest.introSource, 'placeholder');
  });

  it('does not mark human when nextIntro is undefined or null', () => {
    const prev = {
      videoFileId: 'cloud://v1',
      intro: '点击测量。',
      ingest: {
        phase: 'ready',
        mediaRevision: 1,
        videoFileId: 'cloud://v1',
        asr: 'ready',
        introSource: 'auto',
        errorCode: '',
        errorMessage: '',
        queuedAt: 1,
        startedAt: 2,
        finishedAt: 3,
        attempt: 1,
      },
    };
    for (const nextIntro of [undefined, null]) {
      const out = planAdminSave({
        prevData: prev,
        nextVideoFileId: 'cloud://v1',
        nextIntro,
        now: 6000,
      });
      assert.equal(out.ingest.introSource, 'auto');
    }
  });

  it('does not mark human when nextIntro is not a string', () => {
    const prev = {
      videoFileId: 'cloud://v1',
      intro: PLACEHOLDER_INTRO,
      ingest: {
        phase: 'queued',
        mediaRevision: 1,
        videoFileId: 'cloud://v1',
        asr: 'pending',
        introSource: 'placeholder',
        errorCode: '',
        errorMessage: '',
        queuedAt: 1,
        startedAt: 0,
        finishedAt: 0,
        attempt: 1,
      },
    };
    for (const nextIntro of [123, {}, []]) {
      const out = planAdminSave({
        prevData: prev,
        nextVideoFileId: 'cloud://v1',
        nextIntro,
        now: 6000,
      });
      assert.equal(out.ingest.introSource, 'placeholder');
    }
  });

  it('does not enqueue when videoFileId is empty', () => {
    const out = planAdminSave({
      prevData: null,
      nextVideoFileId: '',
      nextIntro: '仅标题',
      now: 1000,
    });
    assert.equal(out.enqueue, false);
    assert.equal(out.clearTranscript, false);
    assert.equal(out.ingest.phase, 'idle');
  });

  it('keeps the stored intro source when the form submits the placeholder back', () => {
    const prev = {
      videoFileId: 'cloud://v1',
      intro: '打开项目后点击测量。',
      ingest: {
        phase: 'ready',
        mediaRevision: 1,
        videoFileId: 'cloud://v1',
        asr: 'ready',
        introSource: 'auto',
        errorCode: '',
        errorMessage: '',
        queuedAt: 1,
        startedAt: 2,
        finishedAt: 3,
        attempt: 1,
      },
    };
    const out = planAdminSave({
      prevData: prev,
      nextVideoFileId: 'cloud://v1',
      nextIntro: PLACEHOLDER_INTRO,
      now: 7000,
    });
    assert.equal(out.ingest.introSource, 'auto');
  });

  it('marks a controlled transcript import ready instead of enqueueing it', () => {
    const out = planAdminSave({
      prevData: null,
      nextVideoFileId: 'cloud://first',
      nextIntro: '人工审核简介',
      controlledTranscript: true,
      now: 8000,
    });
    assert.equal(out.enqueue, false);
    assert.equal(out.clearTranscript, false);
    assert.equal(out.ingest.phase, 'ready');
    assert.equal(out.ingest.asr, 'ready');
    assert.equal(out.ingest.mediaRevision, 1);
    assert.equal(out.ingest.videoFileId, 'cloud://first');
    assert.equal(out.ingest.introSource, 'human');
    assert.equal(out.ingest.finishedAt, 8000);
  });

  it('still enqueues an ops upload that carries no transcript', () => {
    const out = planAdminSave({
      prevData: null,
      nextVideoFileId: 'cloud://first',
      nextIntro: PLACEHOLDER_INTRO,
      controlledTranscript: false,
      now: 8000,
    });
    assert.equal(out.enqueue, true);
    assert.equal(out.ingest.phase, 'queued');
  });
});

describe('resolveNextVideoFileId', () => {
  it('accepts the first upload without an explicit replacement flag', () => {
    assert.equal(
      resolveNextVideoFileId({
        prevVideoFileId: '',
        submittedVideoFileId: 'cloud://first',
        replaceVideo: false,
      }),
      'cloud://first',
    );
  });

  it('ignores a stale form fileId when no replacement is declared', () => {
    assert.equal(
      resolveNextVideoFileId({
        prevVideoFileId: 'cloud://transcoded',
        submittedVideoFileId: 'cloud://original',
        replaceVideo: false,
      }),
      'cloud://transcoded',
    );
  });

  it('replaces the file only when the caller declares a fresh upload', () => {
    assert.equal(
      resolveNextVideoFileId({
        prevVideoFileId: 'cloud://transcoded',
        submittedVideoFileId: 'cloud://new',
        replaceVideo: true,
      }),
      'cloud://new',
    );
  });

  it('keeps the stored file when the request omits one', () => {
    assert.equal(
      resolveNextVideoFileId({
        prevVideoFileId: 'cloud://transcoded',
        submittedVideoFileId: '',
        replaceVideo: true,
      }),
      'cloud://transcoded',
    );
  });
});

describe('isOperatorIntroEdit', () => {
  it('treats the placeholder as no edit when the stored intro is real', () => {
    assert.equal(
      isOperatorIntroEdit({
        prevIntro: '打开项目后点击测量。',
        submittedIntro: PLACEHOLDER_INTRO,
      }),
      false,
    );
  });

  it('still accepts a real rewrite', () => {
    assert.equal(
      isOperatorIntroEdit({
        prevIntro: '打开项目后点击测量。',
        submittedIntro: '运营改写的简介。',
      }),
      true,
    );
  });

  it('accepts the placeholder while the stored intro is still the placeholder', () => {
    assert.equal(
      isOperatorIntroEdit({
        prevIntro: PLACEHOLDER_INTRO,
        submittedIntro: PLACEHOLDER_INTRO,
      }),
      false,
    );
  });
});

describe('isIngestBusy', () => {
  it('is busy only for queued and running', () => {
    assert.equal(isIngestBusy({ phase: 'queued' }), true);
    assert.equal(isIngestBusy({ phase: 'running' }), true);
    assert.equal(isIngestBusy({ phase: 'ready' }), false);
    assert.equal(isIngestBusy({ phase: 'idle' }), false);
    assert.equal(isIngestBusy(undefined), false);
  });
});

describe('planRunningIntro', () => {
  it('keeps the job running and stores the generated intro', () => {
    const out = planRunningIntro({
      prevIngest: { phase: 'running', mediaRevision: 2, introSource: 'placeholder' },
      prevIntro: PLACEHOLDER_INTRO,
      prevIntroSource: 'placeholder',
      prevHumanIntro: '',
      prevAutoIntro: '',
      intro: '千寻本期讲解如何打开项目。',
    });
    assert.equal(out.ingest.phase, 'running');
    assert.equal(out.autoIntro, '千寻本期讲解如何打开项目。');
    assert.equal(out.intro, '千寻本期讲解如何打开项目。');
    assert.equal(out.ingest.introSource, 'auto');
  });

  it('keeps a handwritten intro in front of the generated copy', () => {
    const out = planRunningIntro({
      prevIngest: { phase: 'running', introSource: 'human' },
      prevIntro: '手写简介。',
      prevIntroSource: 'human',
      prevHumanIntro: '手写简介。',
      prevAutoIntro: '',
      intro: '千寻本期讲解如何打开项目。',
    });
    assert.equal(out.intro, '手写简介。');
    assert.equal(out.autoIntro, '千寻本期讲解如何打开项目。');
    assert.equal(out.humanIntro, '手写简介。');
  });
});

describe('planWorkerComplete', () => {
  const base = {
    phase: 'running',
    mediaRevision: 3,
    videoFileId: 'cloud://v1',
    asr: 'pending',
    introSource: 'placeholder',
    errorCode: '',
    errorMessage: '',
    queuedAt: 1,
    startedAt: 2,
    finishedAt: 0,
    attempt: 1,
  };

  it('rejects stale mediaRevision', () => {
    assert.throws(
      () =>
        planWorkerComplete({
          prevIngest: base,
          prevIntro: PLACEHOLDER_INTRO,
          prevIntroSource: 'placeholder',
          complete: { mediaRevision: 2, outcome: 'ready', asr: 'ready' },
          now: 5,
        }),
      (err) => err.code === 'BAD_INPUT',
    );
  });

  it('skips intro when introSource is human', () => {
    const out = planWorkerComplete({
      prevIngest: { ...base, introSource: 'human' },
      prevIntro: '人手写。',
      prevIntroSource: 'human',
      complete: {
        mediaRevision: 3,
        outcome: 'ready',
        asr: 'ready',
        intro: '自动生成应被忽略。',
      },
      now: 9,
    });
    assert.equal(out.applyIntro, false);
    assert.equal(out.intro, '人手写。');
    assert.equal(out.autoIntro, '自动生成应被忽略。');
    assert.equal(out.humanIntro, '人手写。');
    assert.equal(out.ingest.introSource, 'human');
    assert.equal(out.ingest.phase, 'ready');
    assert.equal(out.ingest.asr, 'ready');
  });

  it('keeps placeholder when complete omits intro (ungrounded)', () => {
    const out = planWorkerComplete({
      prevIngest: base,
      prevIntro: PLACEHOLDER_INTRO,
      prevIntroSource: 'placeholder',
      complete: { mediaRevision: 3, outcome: 'ready', asr: 'ready' },
      now: 9,
    });
    assert.equal(out.applyIntro, false);
    assert.equal(out.intro, PLACEHOLDER_INTRO);
    assert.equal(out.ingest.introSource, 'placeholder');
    assert.equal(out.ingest.phase, 'ready');
  });

  it('applies auto intro when allowed', () => {
    const out = planWorkerComplete({
      prevIngest: base,
      prevIntro: PLACEHOLDER_INTRO,
      prevIntroSource: 'placeholder',
      complete: {
        mediaRevision: 3,
        outcome: 'ready',
        asr: 'ready',
        intro: '点击测量。',
      },
      now: 9,
    });
    assert.equal(out.applyIntro, true);
    assert.equal(out.intro, '点击测量。');
    assert.equal(out.ingest.introSource, 'auto');
  });

  it('records failed outcome without writing intro', () => {
    const out = planWorkerComplete({
      prevIngest: base,
      prevIntro: PLACEHOLDER_INTRO,
      prevIntroSource: 'placeholder',
      complete: {
        mediaRevision: 3,
        outcome: 'failed',
        asr: 'failed',
        errorCode: 'ASR_FAILED',
        errorMessage: '转写失败',
      },
      now: 9,
    });
    assert.equal(out.applyIntro, false);
    assert.equal(out.ingest.phase, 'failed');
    assert.equal(out.ingest.errorCode, 'ASR_FAILED');
    assert.equal(out.ingest.asr, 'failed');
  });

  it('treats skipped asr as ready', () => {
    const out = planWorkerComplete({
      prevIngest: base,
      prevIntro: PLACEHOLDER_INTRO,
      prevIntroSource: 'placeholder',
      complete: { mediaRevision: 3, outcome: 'ready', asr: 'skipped' },
      now: 9,
    });
    assert.equal(out.ingest.phase, 'ready');
    assert.equal(out.ingest.asr, 'skipped');
  });

  it('keeps the asr failure message when playback is ready', () => {
    const out = planWorkerComplete({
      prevIngest: base,
      prevIntro: PLACEHOLDER_INTRO,
      prevIntroSource: 'placeholder',
      complete: {
        mediaRevision: 3,
        outcome: 'ready',
        asr: 'failed',
        errorMessage: '转写失败，播放文件已更新',
      },
      now: 9,
    });
    assert.equal(out.ingest.phase, 'ready');
    assert.equal(out.ingest.asr, 'failed');
    assert.equal(out.ingest.errorCode, '');
    assert.equal(out.ingest.errorMessage, '转写失败，播放文件已更新');
    assert.equal(out.applyIntro, false);
    assert.equal(out.intro, PLACEHOLDER_INTRO);
  });

  it('rejects invalid errorCode on failed outcome', () => {
    assert.throws(
      () =>
        planWorkerComplete({
          prevIngest: base,
          prevIntro: PLACEHOLDER_INTRO,
          prevIntroSource: 'placeholder',
          complete: {
            mediaRevision: 3,
            outcome: 'failed',
            asr: 'failed',
            errorCode: 'NOT_A_REAL_CODE',
            errorMessage: 'bad',
          },
          now: 9,
        }),
      (err) => err.code === 'BAD_INPUT',
    );
  });

  it('accepts all allowed failure error codes', () => {
    for (const errorCode of [
      'DOWNLOAD_FAILED',
      'TRANSCODE_FAILED',
      'ASR_FAILED',
      'INTERNAL',
    ]) {
      const out = planWorkerComplete({
        prevIngest: base,
        prevIntro: PLACEHOLDER_INTRO,
        prevIntroSource: 'placeholder',
        complete: {
          mediaRevision: 3,
          outcome: 'failed',
          asr: 'failed',
          errorCode,
          errorMessage: '失败',
        },
        now: 9,
      });
      assert.equal(out.ingest.errorCode, errorCode);
      assert.equal(out.ingest.phase, 'failed');
    }
  });

  it('stores a rejected intro on an unpublished video', () => {
    const out = planWorkerComplete({
      prevIngest: base,
      prevIntro: PLACEHOLDER_INTRO,
      prevIntroSource: 'placeholder',
      prevStatus: 'draft',
      complete: {
        mediaRevision: 3,
        outcome: 'ready',
        asr: 'ready',
        intro: '华测RTK支持四参数计算。',
        introGate: { ok: false, reason: 'term 四参数' },
      },
      now: 9,
    });
    assert.equal(out.intro, '华测RTK支持四参数计算。');
    assert.equal(out.autoIntro, '华测RTK支持四参数计算。');
    assert.equal(out.introReview, 'pending');
    assert.deepEqual(out.introGate, { ok: false, reason: 'term 四参数' });
    assert.equal(out.introRevisions.length, 1);
    assert.deepEqual(out.introRevisions[0], {
      version: 1,
      kind: 'ai',
      text: '华测RTK支持四参数计算。',
      gateOk: false,
      gateReason: 'term 四参数',
      createdAt: 9,
    });
  });

  it('ignores a placeholder or empty intro from the worker', () => {
    const placeholder = planWorkerComplete({
      prevIngest: base,
      prevIntro: PLACEHOLDER_INTRO,
      prevIntroSource: 'placeholder',
      complete: {
        mediaRevision: 3,
        outcome: 'ready',
        asr: 'ready',
        intro: PLACEHOLDER_INTRO,
        introGate: { ok: false, reason: 'placeholder' },
      },
      now: 9,
    });
    assert.equal(placeholder.intro, PLACEHOLDER_INTRO);
    assert.equal(placeholder.autoIntro, '');
    assert.equal(placeholder.introGate, undefined);
    assert.equal(placeholder.introRevisions, undefined);

    const empty = planWorkerComplete({
      prevIngest: base,
      prevIntro: PLACEHOLDER_INTRO,
      prevIntroSource: 'placeholder',
      complete: {
        mediaRevision: 3,
        outcome: 'ready',
        asr: 'ready',
        intro: '   ',
      },
      now: 9,
    });
    assert.equal(empty.intro, PLACEHOLDER_INTRO);
    assert.equal(empty.introRevisions, undefined);
  });

  it('keeps the public intro of a published video and a handwritten intro', () => {
    const published = planWorkerComplete({
      prevIngest: { ...base, introSource: 'auto' },
      prevIntro: '已上架简介。',
      prevIntroSource: 'auto',
      prevAutoIntro: '已上架简介。',
      prevHumanIntro: '',
      prevStatus: 'published',
      complete: {
        mediaRevision: 3,
        outcome: 'ready',
        asr: 'ready',
        intro: '新的自动稿。',
        introGate: { ok: true, reason: '' },
      },
      now: 9,
    });
    assert.equal(published.intro, '已上架简介。');
    assert.equal(published.autoIntro, '新的自动稿。');
    assert.equal(published.introReview, 'pending');

    const handwritten = planWorkerComplete({
      prevIngest: { ...base, introSource: 'human' },
      prevIntro: '人手写。',
      prevIntroSource: 'human',
      prevHumanIntro: '人手写。',
      prevStatus: 'draft',
      complete: {
        mediaRevision: 3,
        outcome: 'ready',
        asr: 'ready',
        intro: '自动生成应被忽略。',
        introGate: { ok: false, reason: 'term 四参数' },
      },
      now: 9,
    });
    assert.equal(handwritten.intro, '人手写。');
    assert.equal(handwritten.autoIntro, '自动生成应被忽略。');
    assert.equal(handwritten.introReview, 'confirmed');
  });

  it('keeps a single ai revision when the same text is noted and then completed', () => {
    const noted = planRunningIntro({
      prevIngest: { phase: 'running', mediaRevision: 3, introSource: 'placeholder' },
      prevIntro: PLACEHOLDER_INTRO,
      prevIntroSource: 'placeholder',
      prevHumanIntro: '',
      prevAutoIntro: '',
      prevStatus: 'draft',
      intro: '同一段自动稿。',
      introGate: { ok: false, reason: 'term 四参数' },
      now: 4,
    });
    const completed = planWorkerComplete({
      prevIngest: base,
      prevIntro: noted.intro,
      prevIntroSource: 'auto',
      prevAutoIntro: noted.autoIntro,
      prevHumanIntro: '',
      prevRevisions: noted.introRevisions,
      prevStatus: 'draft',
      complete: {
        mediaRevision: 3,
        outcome: 'ready',
        asr: 'ready',
        intro: '同一段自动稿。',
        introGate: { ok: true, reason: '' },
      },
      now: 9,
    });
    assert.equal(completed.introRevisions.length, 1);
    assert.equal(completed.introRevisions[0].kind, 'ai');
    assert.deepEqual(completed.introGate, { ok: true, reason: '' });
  });
});

describe('confirmOperatorIntro', () => {
  it('confirms a non-placeholder save and appends a human revision only when the text changes', () => {
    const accepted = confirmOperatorIntro({
      intro: '自动稿。',
      revisions: [{
        version: 1,
        kind: 'ai',
        text: '自动稿。',
        gateOk: false,
        gateReason: 'term 四参数',
        createdAt: 1,
      }],
      now: 2,
    });
    assert.equal(accepted.introReview, 'confirmed');
    assert.equal(accepted.introRevisions.length, 1);

    const edited = confirmOperatorIntro({
      intro: '改写后的简介。',
      revisions: accepted.introRevisions,
      now: 3,
    });
    assert.equal(edited.introReview, 'confirmed');
    assert.equal(edited.introRevisions[1].kind, 'human');
    assert.equal(edited.introRevisions[1].text, '改写后的简介。');
    assert.equal(edited.introRevisions[1].gateOk, null);
    assert.equal(edited.introRevisions[1].gateReason, '');
  });

  it('stays pending without a revision when the intro is still the placeholder', () => {
    const out = confirmOperatorIntro({
      intro: PLACEHOLDER_INTRO,
      revisions: [],
      now: 1,
    });
    assert.equal(out.introReview, 'pending');
    assert.deepEqual(out.introRevisions, []);
  });

  it('keeps the newest 50 revisions and continues the version numbers', () => {
    const revisions = Array.from({ length: 50 }, (_, index) => ({
      version: index + 1,
      kind: 'human',
      text: `旧${index + 1}`,
      gateOk: null,
      gateReason: '',
      createdAt: index,
    }));
    const out = confirmOperatorIntro({
      intro: '新的第51条',
      revisions,
      now: 51,
    });
    assert.equal(out.introRevisions.length, 50);
    assert.equal(out.introRevisions[0].version, 2);
    assert.equal(out.introRevisions[49].version, 51);
    assert.equal(out.introRevisions[49].version > out.introRevisions[0].version, true);
  });
});
