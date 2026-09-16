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

const {
  applyCompleteToVideo,
  buildUpsertIngestPatch,
  createVideoIngestActions,
  getOptionalDocument,
} = actions;

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
  it('keeps controlled transcript import when the first file is added', () => {
    const patch = buildUpsertIngestPatch({
      prevData: null,
      nextVideoFileId: 'cloud://first',
      nextIntro: '人工审核简介',
      now: 5,
    });

    assert.equal(patch.clearTranscript, false);
    assert.equal(patch.enqueue, true);
    assert.equal(patch.ingest.introSource, 'human');
  });

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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createMemoryRepository(initial) {
  let state = clone({
    videos: (initial && initial.videos) || {},
    jobs: (initial && initial.jobs) || {},
  });
  let nextId = 100;
  let transactionTail = Promise.resolve();
  let conflictHook = null;

  function txFor(draft) {
    return {
      async getVideo(id) {
        return draft.videos[id] ? clone(draft.videos[id]) : null;
      },
      async addVideo(data) {
        const id = `video-${nextId++}`;
        draft.videos[id] = { ...clone(data), _id: id };
        return id;
      },
      async updateVideo(id, data) {
        draft.videos[id] = { ...draft.videos[id], ...clone(data), _id: id };
      },
      async removeVideo(id) {
        delete draft.videos[id];
      },
      async addJob(data) {
        const id = `job-${nextId++}`;
        draft.jobs[id] = { ...clone(data), _id: id };
        return id;
      },
      async getJob(id) {
        return draft.jobs[id] ? clone(draft.jobs[id]) : null;
      },
      async updateJob(id, data) {
        draft.jobs[id] = { ...draft.jobs[id], ...clone(data), _id: id };
      },
      async removeJob(id) {
        delete draft.jobs[id];
      },
    };
  }

  return {
    async runTransaction(callback) {
      const previous = transactionTail;
      let release;
      transactionTail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        for (;;) {
          const draft = clone(state);
          const result = await callback(txFor(draft));
          if (conflictHook) {
            const hook = conflictHook;
            conflictHook = null;
            hook(state);
            continue;
          }
          state = draft;
          return result;
        }
      } finally {
        release();
      }
    },
    async findClaimCandidate(now, timeoutMs) {
      const jobs = Object.values(state.jobs);
      return (
        jobs
          .filter((job) => job.phase === 'queued')
          .sort((a, b) => a.createdAt - b.createdAt)[0] ||
        jobs
          .filter(
            (job) =>
              job.phase === 'running' && now - job.claimedAt >= timeoutMs,
          )
          .sort((a, b) => a.claimedAt - b.claimedAt)[0] ||
        null
      );
    },
    async findRunningJob(videoId, mediaRevision) {
      return (
        Object.values(state.jobs).find(
          (job) =>
            job.videoId === videoId &&
            job.mediaRevision === mediaRevision &&
            job.phase === 'running',
        ) || null
      );
    },
    async findJobsForVideo(videoId) {
      return Object.values(state.jobs)
        .filter((item) => item.videoId === videoId)
        .map(clone);
    },
    setConflictHook(hook) {
      conflictHook = hook;
    },
    snapshot() {
      return clone(state);
    },
  };
}

function createActions(repository, now = 1000) {
  assert.equal(typeof createVideoIngestActions, 'function');
  return createVideoIngestActions({
    repository,
    now: () => now,
    buildSearchBlob: (video) => `${video.intro}\n${video.transcript}`,
    nextStatusAfterSave: (status) => status || 'draft',
  });
}

function editableVideo(overrides = {}) {
  return {
    _id: 'v1',
    title: '视频',
    intro: PLACEHOLDER_INTRO,
    brandId: 'b1',
    brandName: '品牌',
    productId: '',
    modelName: '',
    tags: [],
    coverFileId: '',
    videoFileId: 'cloud://v1',
    transcript: '',
    transcriptSegments: [],
    durationSec: 2,
    media: { videoCodec: 'h264', audioCodec: 'aac', hasAudio: true },
    searchAbstract: '',
    entities: { models: [], actions: [], menus: [], aliases: [] },
    status: 'draft',
    createdAt: 1,
    publishedAt: 0,
    updatedAt: 2,
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
    ...overrides,
  };
}

function job(overrides = {}) {
  return {
    _id: 'j1',
    videoId: 'v1',
    mediaRevision: 1,
    phase: 'queued',
    claimedAt: 0,
    claimedBy: '',
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  };
}

function saveInput(overrides = {}) {
  return {
    event: {
      id: 'v1',
      intro: PLACEHOLDER_INTRO,
      videoFileId: 'cloud://v1',
      ...overrides,
    },
    basePayload: {
      title: '视频',
      brandId: 'b1',
      brandName: '品牌',
      productId: '',
      modelName: '',
      tags: [],
    },
  };
}

describe('createVideoIngestActions', () => {
  it('preserves controlled segments and reviewed intro on first upload', async () => {
    const repository = createMemoryRepository();
    const service = createActions(repository);
    const result = await service.saveVideo(
      saveInput({
        id: undefined,
        intro: '人工审核简介',
        videoFileId: 'cloud://first',
        transcriptSegments: [{ startSec: 0, endSec: 1, text: '受控字幕' }],
        durationSec: 2,
      }),
    );
    const saved = repository.snapshot().videos[result.id];

    assert.equal(saved.transcript, '受控字幕');
    assert.deepEqual(saved.transcriptSegments, [
      { startSec: 0, endSec: 1, text: '受控字幕' },
    ]);
    assert.equal(saved.ingest.introSource, 'human');
    assert.equal(saved.ingest.phase, 'ready');
    assert.equal(saved.ingest.asr, 'ready');
    assert.deepEqual(repository.snapshot().jobs, {});
  });

  it('still enqueues an ops upload that carries no transcript', async () => {
    const repository = createMemoryRepository();
    const service = createActions(repository);
    const result = await service.saveVideo(
      saveInput({
        id: undefined,
        intro: PLACEHOLDER_INTRO,
        videoFileId: 'cloud://ops-upload',
      }),
    );
    const state = repository.snapshot();

    assert.equal(state.videos[result.id].ingest.phase, 'queued');
    assert.equal(Object.values(state.jobs).length, 1);
  });

  it('forces transcript empty when replacing an existing file', async () => {
    const repository = createMemoryRepository({
      videos: { v1: editableVideo({ ingest: readyVideo().ingest }) },
    });
    const service = createActions(repository);
    await service.saveVideo(
      saveInput({
        videoFileId: 'cloud://replacement',
        replaceVideo: true,
        transcriptSegments: [{ startSec: 0, endSec: 1, text: '不应保留' }],
      }),
    );

    assert.deepEqual(repository.snapshot().videos.v1.transcriptSegments, []);
    assert.equal(repository.snapshot().videos.v1.transcript, '');
    assert.equal(repository.snapshot().videos.v1.videoFileId, 'cloud://replacement');
  });

  it('ignores a stale form fileId that was never re-uploaded', async () => {
    const repository = createMemoryRepository({
      videos: {
        v1: editableVideo({
          videoFileId: 'cloud://transcoded',
          intro: '自动生成的步骤简介。',
          transcript: '自动字幕',
          transcriptSegments: [{ startSec: 0, endSec: 1, text: '自动字幕' }],
          ingest: {
            ...editableVideo().ingest,
            phase: 'ready',
            asr: 'ready',
            introSource: 'auto',
            videoFileId: 'cloud://transcoded',
          },
        }),
      },
    });
    const service = createActions(repository);
    await service.saveVideo(
      saveInput({ videoFileId: 'cloud://original', intro: '自动生成的步骤简介。' }),
    );
    const state = repository.snapshot();

    assert.equal(state.videos.v1.videoFileId, 'cloud://transcoded');
    assert.equal(state.videos.v1.ingest.videoFileId, 'cloud://transcoded');
    assert.equal(state.videos.v1.ingest.phase, 'ready');
    assert.equal(state.videos.v1.ingest.mediaRevision, 1);
    assert.deepEqual(state.videos.v1.transcriptSegments, [
      { startSec: 0, endSec: 1, text: '自动字幕' },
    ]);
    assert.deepEqual(state.jobs, {});
  });

  it('keeps the stored intro when the form submits the placeholder back', async () => {
    const repository = createMemoryRepository({
      videos: {
        v1: editableVideo({
          intro: '自动生成的步骤简介。',
          ingest: {
            ...editableVideo().ingest,
            phase: 'ready',
            asr: 'ready',
            introSource: 'auto',
          },
        }),
      },
    });
    const service = createActions(repository);
    await service.saveVideo(saveInput({ intro: PLACEHOLDER_INTRO }));
    const saved = repository.snapshot().videos.v1;

    assert.equal(saved.intro, '自动生成的步骤简介。');
    assert.equal(saved.ingest.introSource, 'auto');
  });

  it('recomputes after a completion conflict without reverting worker output', async () => {
    const repository = createMemoryRepository({
      videos: { v1: editableVideo() },
      jobs: { j1: job({ phase: 'running', claimedAt: 20 }) },
    });
    repository.setConflictHook((state) => {
      state.videos.v1.intro = 'worker 简介';
      state.videos.v1.transcript = 'worker 字幕';
      state.videos.v1.transcriptSegments = [
        { startSec: 0, endSec: 1, text: 'worker 字幕' },
      ];
      state.videos.v1.ingest = {
        ...state.videos.v1.ingest,
        phase: 'ready',
        asr: 'ready',
        introSource: 'auto',
        finishedAt: 999,
      };
      state.jobs.j1.phase = 'done';
    });
    const service = createActions(repository);
    await service.saveVideo(saveInput());
    const saved = repository.snapshot().videos.v1;

    assert.equal(saved.ingest.phase, 'ready');
    assert.equal(saved.intro, 'worker 简介');
    assert.equal(saved.transcript, 'worker 字幕');
    assert.deepEqual(saved.transcriptSegments, [
      { startSec: 0, endSec: 1, text: 'worker 字幕' },
    ]);
  });

  it('keeps an explicit operator intro edit human after retry', async () => {
    const repository = createMemoryRepository({
      videos: { v1: editableVideo() },
    });
    repository.setConflictHook((state) => {
      state.videos.v1.intro = 'worker 简介';
      state.videos.v1.ingest = {
        ...state.videos.v1.ingest,
        phase: 'ready',
        introSource: 'auto',
      };
    });
    const service = createActions(repository);
    await service.saveVideo(saveInput({ intro: '运营明确修改' }));
    const saved = repository.snapshot().videos.v1;

    assert.equal(saved.intro, '运营明确修改');
    assert.equal(saved.ingest.introSource, 'human');
    assert.equal(saved.ingest.phase, 'ready');
  });

  it('rejects manual enqueue while busy or without a file', async () => {
    const busyRepository = createMemoryRepository({
      videos: { v1: editableVideo({ ingest: { ...editableVideo().ingest, phase: 'queued' } }) },
    });
    await assert.rejects(
      createActions(busyRepository).enqueueVideo({ id: 'v1' }),
      (error) => error.code === 'BAD_INPUT' && error.message === '正在处理',
    );

    const emptyRepository = createMemoryRepository({
      videos: {
        v1: editableVideo({
          videoFileId: '',
          ingest: { ...editableVideo().ingest, phase: 'idle', videoFileId: '' },
        }),
      },
    });
    await assert.rejects(
      createActions(emptyRepository).enqueueVideo({ id: 'v1' }),
      (error) => error.code === 'BAD_INPUT' && /上传视频/.test(error.message),
    );
  });

  it('allows only one winner when two workers claim the same job', async () => {
    const repository = createMemoryRepository({
      videos: { v1: editableVideo({ ingest: { ...editableVideo().ingest, phase: 'queued' } }) },
      jobs: { j1: job() },
    });
    const service = createActions(repository, 100);
    const results = await Promise.all([
      service.claimVideo({ workerId: 'worker-a' }),
      service.claimVideo({ workerId: 'worker-b' }),
    ]);

    assert.equal(results.filter((result) => result.job).length, 1);
    assert.equal(repository.snapshot().jobs.j1.phase, 'running');
  });

  it('reclaims an expired running job', async () => {
    const repository = createMemoryRepository({
      videos: { v1: editableVideo() },
      jobs: { j1: job({ phase: 'running', claimedAt: 1, claimedBy: 'old' }) },
    });
    const result = await createActions(repository, 30 * 60 * 1000 + 1).claimVideo({
      workerId: 'new',
    });

    assert.equal(result.job.claimedBy, 'new');
  });

  it('rolls back completion when media revision mismatches', async () => {
    const repository = createMemoryRepository({
      videos: { v1: editableVideo() },
      jobs: { j1: job({ phase: 'running', mediaRevision: 0 }) },
    });
    const before = repository.snapshot();
    await assert.rejects(
      createActions(repository).completeVideo({
        videoId: 'v1',
        mediaRevision: 0,
        outcome: 'ready',
        asr: 'ready',
        transcriptSegments: [],
      }),
      (error) => error.code === 'BAD_INPUT',
    );

    assert.deepEqual(repository.snapshot(), before);
  });

  it('marks a missing-video poison job dead so the next claim advances', async () => {
    const repository = createMemoryRepository({
      videos: {
        v2: editableVideo({
          _id: 'v2',
          ingest: { ...editableVideo().ingest, phase: 'queued' },
        }),
      },
      jobs: {
        j1: job({ videoId: 'missing', createdAt: 1 }),
        j2: job({ _id: 'j2', videoId: 'v2', createdAt: 2 }),
      },
    });
    const service = createActions(repository);

    assert.equal((await service.claimVideo({ workerId: 'worker' })).job, null);
    assert.equal(repository.snapshot().jobs.j1.phase, 'dead');
    const next = await service.claimVideo({ workerId: 'worker' });
    assert.equal(next.videoId, 'v2');
  });

  it('deletes unfinished jobs together with a video', async () => {
    const repository = createMemoryRepository({
      videos: { v1: editableVideo() },
      jobs: {
        j1: job({ phase: 'queued' }),
        j2: job({ _id: 'j2', phase: 'running' }),
        j3: job({ _id: 'j3', phase: 'done' }),
      },
    });
    const removed = await createActions(repository).deleteVideo({ videoId: 'v1' });
    const state = repository.snapshot();

    assert.equal(removed._id, 'v1');
    assert.equal(state.videos.v1, undefined);
    assert.equal(state.jobs.j1, undefined);
    assert.equal(state.jobs.j2, undefined);
    assert.equal(state.jobs.j3.phase, 'done');
  });
});

describe('getOptionalDocument', () => {
  it('maps CloudBase missing-document rejection to null', async () => {
    assert.equal(typeof getOptionalDocument, 'function');
    const ref = {
      async get() {
        const error = new Error('document not exist');
        error.errCode = 'DATABASE_DOCUMENT_NOT_EXIST';
        throw error;
      },
    };

    assert.equal(await getOptionalDocument(ref), null);
  });

  it('maps legacy CloudBase document-not-exists message to null', async () => {
    const ref = {
      async get() {
        throw new Error('database collection doc get: document not exists');
      },
    };

    assert.equal(await getOptionalDocument(ref), null);
  });

  it('does not hide unrelated CloudBase errors', async () => {
    const ref = {
      async get() {
        const error = new Error('permission denied');
        error.errCode = 'DATABASE_PERMISSION_DENIED';
        throw error;
      },
    };

    await assert.rejects(() => getOptionalDocument(ref), /permission denied/);
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
