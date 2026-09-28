'use strict';

const {
  CLAIM_TIMEOUT_MS,
  isOperatorIntroEdit,
  normalizeIngest,
  planAdminSave,
  planWorkerComplete,
  resolveNextVideoFileId,
} = require('./videoIngest');
const {
  canEnqueue,
  claimJobRecord,
  createJobRecord,
  finishJobRecord,
} = require('./videoIngestJobs');
const { resolveVideoKnowledge } = require('./videoKnowledge');
const { normalizeVideoMedia } = require('./videoMediaMetadata');

function badInput(message) {
  const error = new Error(message);
  error.code = 'BAD_INPUT';
  return error;
}

function notFound() {
  const error = new Error('NOT_FOUND');
  error.code = 'NOT_FOUND';
  return error;
}

function isDocumentNotExistError(error) {
  const code = error && (error.errCode || error.code);
  const message = String((error && (error.errMsg || error.message)) || '');
  return (
    code === 'DATABASE_DOCUMENT_NOT_EXIST' ||
    code === 'DOCUMENT_NOT_FOUND' ||
    /document(?:\s+\w+)*\s+(?:not|does not)\s+exist/i.test(message)
  );
}

async function getOptionalDocument(documentRef) {
  try {
    const snap = await documentRef.get();
    return snap && snap.data ? snap.data : null;
  } catch (error) {
    if (isDocumentNotExistError(error)) {
      return null;
    }
    throw error;
  }
}

function buildUpsertIngestPatch({
  prevData,
  nextVideoFileId,
  nextIntro,
  controlledTranscript,
  now,
}) {
  return planAdminSave({
    prevData,
    nextVideoFileId,
    nextIntro,
    controlledTranscript,
    now,
  });
}

function hasControlledTranscript(event) {
  return (
    Object.prototype.hasOwnProperty.call(event, 'transcriptSegments') &&
    Array.isArray(event.transcriptSegments) &&
    event.transcriptSegments.length > 0
  );
}

function applyCompleteToVideo({ prevData, complete, now }) {
  const previous = prevData || {};
  const prevIngest = normalizeIngest(previous.ingest);
  const planned = planWorkerComplete({
    prevIngest,
    prevIntro: typeof previous.intro === 'string' ? previous.intro : '',
    prevIntroSource: prevIngest.introSource,
    complete,
    now,
  });

  const mediaInput = {};
  if (Object.prototype.hasOwnProperty.call(complete, 'durationSec')) {
    mediaInput.durationSec = complete.durationSec;
  }
  if (Object.prototype.hasOwnProperty.call(complete, 'media')) {
    mediaInput.media = complete.media;
  }
  const mediaMeta = normalizeVideoMedia(mediaInput, previous, {
    allowPlaybackUpdate: true,
  });

  const shouldApplyTranscript =
    complete.outcome === 'ready' && complete.asr === 'ready';
  const knowledge = shouldApplyTranscript
    ? resolveVideoKnowledge({
        event: complete,
        prevData: previous,
        durationSec: mediaMeta.durationSec,
      })
    : resolveVideoKnowledge({
        event: {},
        prevData: previous,
        durationSec: mediaMeta.durationSec,
      });

  const videoFileId =
    typeof complete.transcodedVideoFileId === 'string' && complete.transcodedVideoFileId
      ? complete.transcodedVideoFileId
      : previous.videoFileId || '';
  const ingest = {
    ...planned.ingest,
    videoFileId,
  };

  return {
    ingest,
    intro: planned.intro,
    transcriptSegments: knowledge.transcriptSegments,
    transcript: knowledge.transcript,
    durationSec: mediaMeta.durationSec,
    media: mediaMeta.media,
    coverFileId:
      previous.coverFileId ||
      (typeof complete.coverFileId === 'string' ? complete.coverFileId : ''),
    videoFileId,
  };
}

function createVideoIngestActions({
  repository,
  now = Date.now,
  buildSearchBlob,
  nextStatusAfterSave,
}) {
  async function replacePlaybackMedia({
    id,
    expectedVideoFileId,
    videoFileId,
    durationSec,
    media,
  }) {
    if (!id || !expectedVideoFileId || !videoFileId) {
      throw badInput('id、expectedVideoFileId 与 videoFileId 必填');
    }
    const mediaMeta = normalizeVideoMedia(
      { durationSec, media },
      null,
      { allowPlaybackUpdate: true },
    );
    if (!mediaMeta.media.playback?.compliant) {
      throw badInput('playback must be compliant');
    }
    await repository.runTransaction(async (transaction) => {
      const current = await transaction.getVideo(id);
      if (!current) {
        throw notFound();
      }
      if (current.videoFileId !== expectedVideoFileId) {
        throw badInput('expectedVideoFileId mismatch');
      }
      const timestamp = now();
      const currentIngest = normalizeIngest(current.ingest);
      await transaction.updateVideo(id, {
        videoFileId,
        durationSec: mediaMeta.durationSec,
        media: mediaMeta.media,
        ingest: {
          ...currentIngest,
          phase: 'ready',
          mediaRevision: currentIngest.mediaRevision + 1,
          videoFileId,
          errorCode: '',
          errorMessage: '',
          queuedAt: 0,
          startedAt: 0,
          finishedAt: timestamp,
        },
        updatedAt: timestamp,
      });
    });
    return { ok: true, id, oldVideoFileId: expectedVideoFileId };
  }

  async function saveVideo({ event, basePayload }) {
    let operatorChangedIntro;
    const saved = await repository.runTransaction(async (transaction) => {
      const prevData = event.id ? await transaction.getVideo(event.id) : null;
      if (event.id && !prevData) {
        throw notFound();
      }
      const submittedIntro = String(event.intro || '').trim();
      if (operatorChangedIntro === undefined) {
        operatorChangedIntro = isOperatorIntroEdit({
          prevIntro: prevData ? String(prevData.intro || '') : '',
          submittedIntro,
        });
      }
      const intro =
        prevData && !operatorChangedIntro
          ? String(prevData.intro || '')
          : submittedIntro;
      const nextVideoFileId = resolveNextVideoFileId({
        prevVideoFileId: (prevData && prevData.videoFileId) || '',
        submittedVideoFileId: String(event.videoFileId || ''),
        replaceVideo: event.replaceVideo === true,
      });
      const timestamp = now();
      const planned = buildUpsertIngestPatch({
        prevData,
        nextVideoFileId,
        nextIntro: intro,
        controlledTranscript: hasControlledTranscript(event),
        now: timestamp,
      });
      const previousForMedia = planned.clearPlayback
        ? {
            ...prevData,
            media: {
              videoCodec: String(prevData?.media?.videoCodec || ''),
              audioCodec: String(prevData?.media?.audioCodec || ''),
              hasAudio: Boolean(prevData?.media?.hasAudio),
            },
          }
        : prevData;
      const mediaInput = planned.clearPlayback
        ? { media: previousForMedia.media }
        : {};
      if (Object.prototype.hasOwnProperty.call(event, 'durationSec')) {
        mediaInput.durationSec = event.durationSec;
      }
      if (Object.prototype.hasOwnProperty.call(event, 'media')) {
        mediaInput.media = event.media;
      }
      const mediaMeta = normalizeVideoMedia(mediaInput, previousForMedia, {
        allowPlaybackUpdate:
          !String(prevData?.videoFileId || '').trim() &&
          hasControlledTranscript(event),
      });
      const knowledgeEvent = planned.clearTranscript
        ? Object.assign({}, event, { transcriptSegments: [] })
        : event;
      const knowledge = resolveVideoKnowledge({
        event: knowledgeEvent,
        prevData,
        durationSec: mediaMeta.durationSec,
      });
      const payload = {
        ...basePayload,
        intro,
        coverFileId:
          event.coverFileId || (prevData && prevData.coverFileId) || '',
        videoFileId: nextVideoFileId,
        transcript: knowledge.transcript,
        transcriptSegments: knowledge.transcriptSegments,
        durationSec: mediaMeta.durationSec,
        media: mediaMeta.media,
        ingest: planned.ingest,
        searchAbstract:
          event.searchAbstract || (prevData && prevData.searchAbstract) || '',
        entities:
          event.entities ||
          (prevData && prevData.entities) || {
            models: [],
            actions: [],
            menus: [],
            aliases: [],
          },
        status: event.id
          ? nextStatusAfterSave(prevData && prevData.status)
          : 'draft',
        searchBlob: '',
        updatedAt: timestamp,
      };
      payload.searchBlob = buildSearchBlob(payload);

      let videoId = event.id;
      if (videoId) {
        await transaction.updateVideo(videoId, payload);
      } else {
        payload.createdAt = timestamp;
        payload.publishedAt = 0;
        videoId = await transaction.addVideo(payload);
      }
      if (planned.enqueue) {
        await transaction.addJob(
          createJobRecord({
            videoId,
            mediaRevision: planned.ingest.mediaRevision,
            now: timestamp,
          }),
        );
      }
      return { id: videoId };
    });
    return { ok: true, id: saved.id };
  }

  async function enqueueVideo({ id }) {
    if (!id) {
      throw badInput('视频 id 必填');
    }
    await repository.runTransaction(async (transaction) => {
      const video = await transaction.getVideo(id);
      if (!video) {
        throw notFound();
      }
      const ingest = normalizeIngest(video.ingest);
      if (!canEnqueue(ingest.phase)) {
        throw badInput('正在处理');
      }
      const videoFileId = video.videoFileId || ingest.videoFileId;
      if (!videoFileId) {
        throw badInput('请先上传视频');
      }
      const timestamp = now();
      const nextIngest = {
        ...ingest,
        phase: 'queued',
        videoFileId,
        asr: 'pending',
        errorCode: '',
        errorMessage: '',
        queuedAt: timestamp,
        startedAt: 0,
        finishedAt: 0,
        attempt: ingest.attempt + 1,
      };
      await transaction.updateVideo(id, {
        ingest: nextIngest,
        updatedAt: timestamp,
      });
      await transaction.addJob(
        createJobRecord({
          videoId: id,
          mediaRevision: nextIngest.mediaRevision,
          now: timestamp,
        }),
      );
    });
    return { ok: true, id };
  }

  async function claimVideo({ workerId }) {
    if (!workerId) {
      throw badInput('workerId 必填');
    }
    const timestamp = now();
    const candidate = await repository.findClaimCandidate(
      timestamp,
      CLAIM_TIMEOUT_MS,
    );
    if (!candidate) {
      return { ok: true, job: null };
    }
    return await repository.runTransaction(async (transaction) => {
      const currentJob = await transaction.getJob(candidate._id);
      const claimed = currentJob
        ? claimJobRecord({
            job: currentJob,
            workerId,
            now: timestamp,
            timeoutMs: CLAIM_TIMEOUT_MS,
          })
        : null;
      if (!claimed) {
        return { ok: true, job: null };
      }
      const video = await transaction.getVideo(claimed.videoId);
      const ingest = normalizeIngest(video && video.ingest);
      if (!video || ingest.mediaRevision !== claimed.mediaRevision) {
        const dead = finishJobRecord({
          job: claimed,
          now: timestamp,
          phase: 'dead',
        });
        await transaction.updateJob(candidate._id, dead);
        return { ok: true, job: null };
      }
      await transaction.updateJob(candidate._id, claimed);
      await transaction.updateVideo(claimed.videoId, {
        ingest: { ...ingest, phase: 'running', startedAt: timestamp },
        updatedAt: timestamp,
      });
      return {
        ok: true,
        job: { ...claimed, _id: candidate._id },
        videoId: claimed.videoId,
        mediaRevision: claimed.mediaRevision,
        videoFileId: video.videoFileId || ingest.videoFileId,
      };
    });
  }

  async function completeVideo(complete) {
    if (!complete.videoId) {
      throw badInput('videoId 必填');
    }
    const candidate = await repository.findRunningJob(
      complete.videoId,
      complete.mediaRevision,
    );
    if (!candidate) {
      throw badInput('运行中的任务不存在');
    }
    await repository.runTransaction(async (transaction) => {
      const video = await transaction.getVideo(complete.videoId);
      if (!video) {
        throw notFound();
      }
      const timestamp = now();
      const patch = applyCompleteToVideo({
        prevData: video,
        complete,
        now: timestamp,
      });
      const job = await transaction.getJob(candidate._id);
      if (!job || job.phase !== 'running') {
        throw badInput('任务已被处理');
      }
      const finished = finishJobRecord({
        job,
        now: timestamp,
        phase: 'done',
      });
      await transaction.updateVideo(complete.videoId, {
        ...patch,
        searchBlob: buildSearchBlob({ ...video, ...patch }),
        updatedAt: timestamp,
      });
      await transaction.updateJob(candidate._id, finished);
    });
    return { ok: true, videoId: complete.videoId };
  }

  async function deleteVideo({ videoId }) {
    const video = await repository.runTransaction(async (transaction) => {
      const video = await transaction.getVideo(videoId);
      if (!video) {
        throw notFound();
      }
      await transaction.removeVideo(videoId);
      return video;
    });
    const jobs = await repository.findJobsForVideo(videoId);
    await repository.runTransaction(async (transaction) => {
      for (const item of jobs) {
        if (item.phase === 'queued' || item.phase === 'running') {
          await transaction.removeJob(item._id);
        }
      }
    });
    return video;
  }

  return {
    claimVideo,
    completeVideo,
    deleteVideo,
    enqueueVideo,
    replacePlaybackMedia,
    saveVideo,
  };
}

module.exports = {
  applyCompleteToVideo,
  buildUpsertIngestPatch,
  createVideoIngestActions,
  getOptionalDocument,
  isDocumentNotExistError,
};
