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

// 运营表单里的 videoFileId 可能是 worker 换过转码文件之前的旧值，把它当成换片会白白
// 清掉字幕并重排一次。只有调用方显式声明本次新上传，或库里本来就没有文件，才允许改。
function resolveNextVideoFileId({ prevVideoFileId, submittedVideoFileId, replaceVideo }) {
  const previous = typeof prevVideoFileId === 'string' ? prevVideoFileId : '';
  const submitted = typeof submittedVideoFileId === 'string' ? submittedVideoFileId : '';
  if (!submitted) {
    return previous;
  }
  if (replaceVideo === true || !previous) {
    return submitted;
  }
  return previous;
}

function storedCoverSource(video) {
  const coverFileId = cleanText(video && video.coverFileId);
  const source = cleanText(video && video.coverSource);
  if (source === 'auto' || source === 'human') {
    return source;
  }
  return coverFileId ? 'human' : 'placeholder';
}

function resolveAdminCover({ prevData, event, replacingVideo }) {
  const previousFileId = cleanText(prevData && prevData.coverFileId);
  const previousSource = storedCoverSource(prevData);
  const submittedFileId = cleanText(event && event.coverFileId);
  if (submittedFileId && submittedFileId !== previousFileId) {
    return { coverFileId: submittedFileId, coverSource: 'human' };
  }
  if (replacingVideo && previousSource === 'auto') {
    return { coverFileId: '', coverSource: 'placeholder' };
  }
  return {
    coverFileId: previousFileId || submittedFileId,
    coverSource: previousFileId || submittedFileId ? previousSource : 'placeholder',
  };
}

function resolveWorkerCover(prevData, complete) {
  const previousFileId = cleanText(prevData && prevData.coverFileId);
  if (previousFileId) {
    return {
      coverFileId: previousFileId,
      coverSource: storedCoverSource(prevData),
    };
  }
  const generatedFileId = cleanText(complete && complete.coverFileId);
  return {
    coverFileId: generatedFileId,
    coverSource: generatedFileId ? 'auto' : 'placeholder',
  };
}

// 管理端表单会把占位句原样回传，此时库里可能已经有 worker 写好的简介，不能被盖掉。
function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function withoutPlaceholder(value) {
  const text = cleanText(value);
  return text === PLACEHOLDER_INTRO ? '' : text;
}

function splitVideoCopies(video) {
  const source = video && typeof video === 'object' ? video : {};
  const ingest = source.ingest && typeof source.ingest === 'object' ? source.ingest : {};
  const introSource = ingest.introSource || 'placeholder';
  const hasTitleCopies = typeof source.humanTitle === 'string' || typeof source.autoTitle === 'string';
  const hasIntroCopies = typeof source.humanIntro === 'string' || typeof source.autoIntro === 'string';
  const autoTitle = typeof source.autoTitle === 'string' ? source.autoTitle.trim() : '';
  const humanTitle = typeof source.humanTitle === 'string'
    ? source.humanTitle.trim()
    : (hasTitleCopies ? '' : cleanText(source.title));
  let autoIntro = '';
  let humanIntro = '';
  if (hasIntroCopies) {
    autoIntro = withoutPlaceholder(source.autoIntro);
    humanIntro = withoutPlaceholder(source.humanIntro);
  } else if (introSource === 'auto') {
    autoIntro = withoutPlaceholder(source.intro);
  } else {
    humanIntro = withoutPlaceholder(source.intro);
  }
  return { autoTitle, humanTitle, autoIntro, humanIntro };
}

function effectiveTitle(humanTitle, autoTitle) {
  return cleanText(humanTitle) || cleanText(autoTitle);
}

function effectiveIntro(humanIntro, autoIntro) {
  return cleanText(humanIntro) || cleanText(autoIntro) || PLACEHOLDER_INTRO;
}

function introSourceFromCopies(humanIntro, autoIntro) {
  if (cleanText(humanIntro)) {
    return 'human';
  }
  if (cleanText(autoIntro)) {
    return 'auto';
  }
  return 'placeholder';
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function resolveStoredCopies({ prevData, event, baseTitle }) {
  const prev = splitVideoCopies(prevData || {});
  const hasStoredTitles = Boolean(
    prevData && (typeof prevData.humanTitle === 'string' || typeof prevData.autoTitle === 'string'),
  );
  const humanTitle = hasOwn(event, 'humanTitle')
    ? cleanText(event.humanTitle)
    : (hasStoredTitles ? prev.humanTitle : cleanText(baseTitle || (prevData && prevData.title) || ''));
  const autoTitle = hasOwn(event, 'autoTitle') ? cleanText(event.autoTitle) : prev.autoTitle;
  let humanIntro = prev.humanIntro;
  if (hasOwn(event, 'humanIntro')) {
    humanIntro = withoutPlaceholder(event.humanIntro);
  } else if (hasOwn(event, 'intro')) {
    const submitted = withoutPlaceholder(event.intro);
    const previous = cleanText(prevData && prevData.intro);
    if (submitted && submitted !== previous) {
      humanIntro = submitted;
    }
  }
  return {
    humanTitle,
    autoTitle,
    humanIntro,
    autoIntro: prev.autoIntro,
  };
}

function isOperatorIntroEdit({ prevIntro, submittedIntro }) {
  const previous = typeof prevIntro === 'string' ? prevIntro : '';
  const submitted = typeof submittedIntro === 'string' ? submittedIntro : '';
  if (submitted === PLACEHOLDER_INTRO && previous && previous !== PLACEHOLDER_INTRO) {
    return false;
  }
  return submitted !== previous;
}

function resolveIntroSource(prevData, nextIntro, ingest) {
  if (typeof nextIntro !== 'string') {
    return ingest.introSource;
  }
  const prevIntro = prevData && typeof prevData.intro === 'string' ? prevData.intro : '';
  if (nextIntro === PLACEHOLDER_INTRO) {
    return ingest.introSource;
  }
  if (nextIntro !== prevIntro) {
    return 'human';
  }
  return ingest.introSource;
}

function planAdminSave({
  prevData,
  nextVideoFileId,
  nextIntro,
  controlledTranscript = false,
  now,
}) {
  const prevVideoFileId =
    prevData && typeof prevData.videoFileId === 'string' ? prevData.videoFileId : '';
  const prevIngest = normalizeIngest(prevData && prevData.ingest);

  if (!nextVideoFileId) {
    const ingest = { ...prevIngest, introSource: resolveIntroSource(prevData, nextIntro, prevIngest) };
    return { ingest, enqueue: false, clearTranscript: false, clearPlayback: false };
  }

  if (nextVideoFileId !== prevVideoFileId) {
    const isReplacement = Boolean(prevVideoFileId);
    // 导入脚本已经带来审核过的字幕，再排一次队只会让 worker 覆盖受控内容。
    // 提升 mediaRevision 让任何遗留任务在 claim 时作废。
    if (controlledTranscript && !isReplacement) {
      const ingest = {
        ...prevIngest,
        phase: 'ready',
        mediaRevision: prevIngest.mediaRevision + 1,
        videoFileId: nextVideoFileId,
        asr: 'ready',
        introSource: resolveIntroSource(prevData, nextIntro, prevIngest),
        errorCode: '',
        errorMessage: '',
        queuedAt: 0,
        startedAt: 0,
        finishedAt: now,
      };
      return {
        ingest,
        enqueue: false,
        clearTranscript: false,
        clearPlayback: isReplacement,
      };
    }
    const ingest = {
      ...prevIngest,
      phase: 'queued',
      mediaRevision: prevIngest.mediaRevision + 1,
      videoFileId: nextVideoFileId,
      asr: 'pending',
      introSource: isReplacement
        ? 'placeholder'
        : resolveIntroSource(prevData, nextIntro, prevIngest),
      errorCode: '',
      errorMessage: '',
      queuedAt: now,
      startedAt: 0,
      finishedAt: 0,
      attempt: prevIngest.attempt + 1,
    };
    return {
      ingest,
      enqueue: true,
      clearTranscript: isReplacement,
      clearPlayback: isReplacement,
    };
  }

  const ingest = {
    ...prevIngest,
    introSource: resolveIntroSource(prevData, nextIntro, prevIngest),
  };
  return { ingest, enqueue: false, clearTranscript: false, clearPlayback: false };
}

const MAX_INTRO_REVISIONS = 50;

function revisionList(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
}

function nextRevisionVersion(revisions) {
  return revisions.reduce((max, item) => Math.max(max, Number(item.version) || 0), 0) + 1;
}

function trimIntroRevisions(revisions) {
  if (revisions.length <= MAX_INTRO_REVISIONS) {
    return revisions;
  }
  return revisions.slice(revisions.length - MAX_INTRO_REVISIONS);
}

function resolveIntroReview(doc) {
  const review = doc && doc.introReview;
  if (review === 'pending' || review === 'confirmed') {
    return review;
  }
  const intro = cleanText(doc && doc.intro);
  if (intro && intro !== PLACEHOLDER_INTRO) {
    return 'confirmed';
  }
  return 'pending';
}

function normalizeIntroGate(introGate) {
  if (introGate && introGate.ok === false) {
    return {
      ok: false,
      reason: typeof introGate.reason === 'string' ? introGate.reason : '',
    };
  }
  return { ok: true, reason: '' };
}

function recordGeneratedIntro({
  prevIntro,
  humanIntro,
  status,
  revisions,
  generated,
  introGate,
  now,
}) {
  const text = withoutPlaceholder(generated);
  if (!text) {
    return null;
  }
  const human = withoutPlaceholder(humanIntro);
  const previousIntro = cleanText(prevIntro) || PLACEHOLDER_INTRO;
  let intro = previousIntro;
  let nextReview = human ? 'confirmed' : 'pending';
  if (!human && status !== 'published') {
    intro = text;
  }
  if (human) {
    intro = cleanText(humanIntro) || previousIntro;
  }
  const gate = normalizeIntroGate(introGate);
  const list = revisionList(revisions);
  const latestAi = [...list].reverse().find((item) => item.kind === 'ai');
  let introRevisions = list;
  if (!latestAi || latestAi.text !== text) {
    introRevisions = trimIntroRevisions(list.concat([{
      version: nextRevisionVersion(list),
      kind: 'ai',
      text,
      gateOk: gate.ok,
      gateReason: gate.reason,
      createdAt: Number(now) || 0,
    }]));
  }
  return {
    intro,
    autoIntro: text,
    humanIntro: human,
    introReview: nextReview,
    introGate: gate,
    introRevisions,
    introSource: introSourceFromCopies(human, text),
    previousIntro,
  };
}

function confirmOperatorIntro({ intro, revisions, now }) {
  const text = withoutPlaceholder(intro);
  const list = revisionList(revisions);
  if (!text) {
    return { introReview: 'pending', introRevisions: list };
  }
  const latest = list.length > 0 ? list[list.length - 1] : null;
  let introRevisions = list;
  if (!latest || latest.text !== text) {
    introRevisions = trimIntroRevisions(list.concat([{
      version: nextRevisionVersion(list),
      kind: 'human',
      text,
      gateOk: null,
      gateReason: '',
      createdAt: Number(now) || 0,
    }]));
  }
  return { introReview: 'confirmed', introRevisions };
}

function planWorkerComplete({
  prevIngest,
  prevIntro,
  prevIntroSource,
  prevHumanIntro,
  prevAutoIntro,
  prevStatus,
  prevRevisions,
  complete,
  now,
}) {
  if (!complete || complete.mediaRevision !== prevIngest.mediaRevision) {
    throw badInput('mediaRevision mismatch');
  }

  const stored = splitVideoCopies({
    intro: prevIntro,
    ingest: { introSource: prevIntroSource || prevIngest.introSource },
    ...(typeof prevHumanIntro === 'string' || typeof prevAutoIntro === 'string'
      ? {
          humanIntro: typeof prevHumanIntro === 'string' ? prevHumanIntro : '',
          autoIntro: typeof prevAutoIntro === 'string' ? prevAutoIntro : '',
        }
      : {}),
  });
  const ingest = { ...prevIngest };
  let humanIntro = stored.humanIntro;
  let autoIntro = stored.autoIntro;
  let intro = effectiveIntro(humanIntro, autoIntro);
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
    return { ingest, intro, autoIntro, humanIntro, applyIntro };
  }

  ingest.phase = 'ready';
  ingest.asr = complete.asr || 'ready';
  ingest.errorCode = '';
  ingest.errorMessage =
    ingest.asr === 'failed' && typeof complete.errorMessage === 'string'
      ? complete.errorMessage
      : '';
  ingest.finishedAt = now;

  const recorded = recordGeneratedIntro({
    prevIntro,
    humanIntro,
    status: prevStatus,
    revisions: prevRevisions,
    generated: complete.intro,
    introGate: complete.introGate,
    now,
  });
  if (!recorded) {
    ingest.introSource = introSourceFromCopies(humanIntro, autoIntro);
    return { ingest, intro, autoIntro, humanIntro, applyIntro };
  }
  ingest.introSource = recorded.introSource;
  applyIntro = recorded.intro !== intro;
  return {
    ingest,
    intro: recorded.intro,
    autoIntro: recorded.autoIntro,
    humanIntro: recorded.humanIntro,
    applyIntro,
    introReview: recorded.introReview,
    introGate: recorded.introGate,
    introRevisions: recorded.introRevisions,
  };
}

function planRunningIntro({
  prevIngest,
  prevIntro,
  prevIntroSource,
  prevHumanIntro,
  prevAutoIntro,
  prevStatus,
  prevRevisions,
  intro,
  introGate,
  now,
}) {
  const stored = splitVideoCopies({
    intro: prevIntro,
    ingest: { introSource: prevIntroSource || prevIngest.introSource },
    ...(typeof prevHumanIntro === 'string' || typeof prevAutoIntro === 'string'
      ? {
          humanIntro: typeof prevHumanIntro === 'string' ? prevHumanIntro : '',
          autoIntro: typeof prevAutoIntro === 'string' ? prevAutoIntro : '',
        }
      : {}),
  });
  const recorded = recordGeneratedIntro({
    prevIntro,
    humanIntro: stored.humanIntro,
    status: prevStatus,
    revisions: prevRevisions,
    generated: intro,
    introGate,
    now,
  });
  if (!recorded) {
    return null;
  }
  return {
    ingest: {
      ...prevIngest,
      introSource: recorded.introSource,
    },
    intro: recorded.intro,
    autoIntro: recorded.autoIntro,
    humanIntro: recorded.humanIntro,
    introReview: recorded.introReview,
    introGate: recorded.introGate,
    introRevisions: recorded.introRevisions,
  };
}

module.exports = {
  PLACEHOLDER_INTRO,
  CLAIM_TIMEOUT_MS,
  normalizeIngest,
  isIngestBusy,
  isOperatorIntroEdit,
  planAdminSave,
  planWorkerComplete,
  planRunningIntro,
  confirmOperatorIntro,
  resolveIntroReview,
  resolveNextVideoFileId,
  resolveStoredCopies,
  splitVideoCopies,
  effectiveTitle,
  effectiveIntro,
  introSourceFromCopies,
  resolveAdminCover,
  resolveWorkerCover,
  storedCoverSource,
};
