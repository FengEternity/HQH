'use strict';

const PLACEHOLDER_INTRO = '讲解处理中，完成后请核对简介。';
const CLAIM_TIMEOUT_MS = 30 * 60 * 1000;

const ALLOWED_ERROR_CODES = new Set([
  'DOWNLOAD_FAILED',
  'TRANSCODE_FAILED',
  'ASR_FAILED',
  'INTERNAL',
]);

function badInput(message) {
  const err = new Error(message);
  err.code = 'BAD_INPUT';
  return err;
}

function normalizeIngest(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    phase: src.phase || 'idle',
    mediaRevision: Number.isFinite(src.mediaRevision) ? src.mediaRevision : 0,
    videoFileId: typeof src.videoFileId === 'string' ? src.videoFileId : '',
    asr: src.asr || 'pending',
    introSource: src.introSource || 'placeholder',
    errorCode: typeof src.errorCode === 'string' ? src.errorCode : '',
    errorMessage: typeof src.errorMessage === 'string' ? src.errorMessage : '',
    queuedAt: Number.isFinite(src.queuedAt) ? src.queuedAt : 0,
    startedAt: Number.isFinite(src.startedAt) ? src.startedAt : 0,
    finishedAt: Number.isFinite(src.finishedAt) ? src.finishedAt : 0,
    attempt: Number.isFinite(src.attempt) ? src.attempt : 0,
  };
}

function isIngestBusy(ingest) {
  const phase = ingest && ingest.phase;
  return phase === 'queued' || phase === 'running';
}

function resolveIntroSource(prevData, nextIntro, ingest) {
  const prevIntro = prevData && typeof prevData.intro === 'string' ? prevData.intro : '';
  if (nextIntro === PLACEHOLDER_INTRO) {
    return ingest.introSource;
  }
  if (nextIntro !== prevIntro) {
    return 'human';
  }
  return ingest.introSource;
}

function planAdminSave({ prevData, nextVideoFileId, nextIntro, now }) {
  const prevVideoFileId =
    prevData && typeof prevData.videoFileId === 'string' ? prevData.videoFileId : '';
  const prevIngest = normalizeIngest(prevData && prevData.ingest);

  if (!nextVideoFileId) {
    const ingest = { ...prevIngest, introSource: resolveIntroSource(prevData, nextIntro, prevIngest) };
    return { ingest, enqueue: false, clearTranscript: false };
  }

  if (nextVideoFileId !== prevVideoFileId) {
    const ingest = {
      ...prevIngest,
      phase: 'queued',
      mediaRevision: prevIngest.mediaRevision + 1,
      videoFileId: nextVideoFileId,
      asr: 'pending',
      introSource: 'placeholder',
      errorCode: '',
      errorMessage: '',
      queuedAt: now,
      startedAt: 0,
      finishedAt: 0,
      attempt: prevIngest.attempt + 1,
    };
    return { ingest, enqueue: true, clearTranscript: true };
  }

  const ingest = {
    ...prevIngest,
    introSource: resolveIntroSource(prevData, nextIntro, prevIngest),
  };
  return { ingest, enqueue: false, clearTranscript: false };
}

function planWorkerComplete({
  prevIngest,
  prevIntro,
  prevIntroSource,
  complete,
  now,
}) {
  if (!complete || complete.mediaRevision !== prevIngest.mediaRevision) {
    throw badInput('mediaRevision mismatch');
  }

  const ingest = { ...prevIngest };
  let intro = prevIntro;
  let applyIntro = false;

  if (complete.outcome === 'failed') {
    if (!complete.errorCode || !ALLOWED_ERROR_CODES.has(complete.errorCode)) {
      throw badInput('invalid errorCode');
    }
    ingest.phase = 'failed';
    ingest.asr = complete.asr || 'failed';
    ingest.errorCode = complete.errorCode;
    ingest.errorMessage =
      typeof complete.errorMessage === 'string' ? complete.errorMessage : '';
    ingest.finishedAt = now;
    return { ingest, intro, applyIntro };
  }

  ingest.phase = 'ready';
  ingest.asr = complete.asr || 'ready';
  ingest.errorCode = '';
  ingest.errorMessage = '';
  ingest.finishedAt = now;

  if (
    prevIntroSource !== 'human' &&
    typeof complete.intro === 'string' &&
    complete.intro.length > 0
  ) {
    applyIntro = true;
    intro = complete.intro;
    ingest.introSource = 'auto';
  } else if (prevIntroSource === 'human') {
    ingest.introSource = 'human';
  }

  return { ingest, intro, applyIntro };
}

module.exports = {
  PLACEHOLDER_INTRO,
  CLAIM_TIMEOUT_MS,
  normalizeIngest,
  isIngestBusy,
  planAdminSave,
  planWorkerComplete,
};
