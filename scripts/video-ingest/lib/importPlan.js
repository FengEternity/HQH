const fs = require('node:fs');
const path = require('node:path');

const EMPTY_ENTITIES = Object.freeze({
  models: Object.freeze([]),
  actions: Object.freeze([]),
  menus: Object.freeze([]),
  aliases: Object.freeze([]),
});

function isNonEmptyFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function resolvePreparedFile(manifestDirectory, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) {
    return null;
  }
  const root = path.resolve(manifestDirectory);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    return null;
  }
  return resolved;
}

function validateEntry(entry, manifestDirectory) {
  const issues = [];
  if (entry?.transcription?.status !== 'ready') {
    issues.push('TRANSCRIPTION_NOT_READY');
  }
  if (entry?.introStatus !== 'reviewed') {
    issues.push('INTRO_NOT_REVIEWED');
  }
  if (!String(entry?.title || '').trim()) {
    issues.push('TITLE_REQUIRED');
  }
  if (!String(entry?.brandName || '').trim()) {
    issues.push('BRAND_NAME_REQUIRED');
  }
  if (!String(entry?.intro || '').trim()) {
    issues.push('INTRO_REQUIRED');
  }
  if (!Array.isArray(entry?.tags)) {
    issues.push('TAGS_INVALID');
  } else if (entry.tags.some((tag) => typeof tag !== 'string' || !tag.trim())) {
    issues.push('TAG_ELEMENTS_INVALID');
  }
  if (typeof entry?.modelName !== 'string') {
    issues.push('MODEL_NAME_INVALID');
  }
  if (
    typeof entry?.durationSec !== 'number' ||
    !Number.isFinite(entry.durationSec) ||
    entry.durationSec < 0
  ) {
    issues.push('DURATION_INVALID');
  }
  const media = entry?.media;
  if (!media || typeof media !== 'object' || Array.isArray(media)) {
    issues.push('MEDIA_INVALID');
  } else {
    const allowedFields = new Set(['videoCodec', 'audioCodec', 'hasAudio']);
    if (Object.keys(media).some((field) => !allowedFields.has(field))) {
      issues.push('MEDIA_FIELDS_INVALID');
    }
    if (typeof media.videoCodec !== 'string') {
      issues.push('VIDEO_CODEC_INVALID');
    }
    if (typeof media.audioCodec !== 'string') {
      issues.push('AUDIO_CODEC_INVALID');
    }
    if (typeof media.hasAudio !== 'boolean') {
      issues.push('HAS_AUDIO_INVALID');
    }
  }
  if (!Array.isArray(entry?.transcriptSegments) || entry.transcriptSegments.length === 0) {
    issues.push('TRANSCRIPT_SEGMENTS_REQUIRED');
  } else {
    let previousStartSec = -Infinity;
    const invalidSegment = entry.transcriptSegments.some((segment) => {
      if (!segment || typeof segment !== 'object') {
        return true;
      }
      const { startSec, endSec } = segment;
      const valid =
        typeof startSec === 'number' &&
        Number.isFinite(startSec) &&
        startSec >= 0 &&
        typeof endSec === 'number' &&
        Number.isFinite(endSec) &&
        endSec > startSec &&
        startSec >= previousStartSec &&
        String(segment.text || '').trim();
      previousStartSec = startSec;
      return !valid;
    });
    if (invalidSegment) {
      issues.push('TRANSCRIPT_SEGMENT_INVALID');
    }
  }
  if (entry?.import?.draft?.status === 'inflight' && !entry.import.draft.videoId) {
    issues.push('DRAFT_INFLIGHT_REQUIRES_REVIEW');
  }

  const coverPath = resolvePreparedFile(manifestDirectory, entry?.prepared?.cover);
  const mediaPath = resolvePreparedFile(manifestDirectory, entry?.prepared?.media);
  if (!coverPath || !isNonEmptyFile(coverPath)) {
    issues.push('COVER_FILE_MISSING');
  }
  if (!mediaPath || !isNonEmptyFile(mediaPath)) {
    issues.push('MEDIA_FILE_MISSING');
  }
  return { issues, coverPath, mediaPath };
}

function buildDraftPayload(entry, resolved) {
  const payload = {
    title: entry.title,
    intro: entry.intro,
    brandId: resolved.brandId,
    modelName: entry.modelName || '',
    tags: [...entry.tags],
    coverFileId: resolved.coverFileId,
    videoFileId: resolved.videoFileId,
    durationSec: entry.durationSec,
    media: { ...entry.media },
    searchAbstract: '',
    entities: {
      models: [...EMPTY_ENTITIES.models],
      actions: [...EMPTY_ENTITIES.actions],
      menus: [...EMPTY_ENTITIES.menus],
      aliases: [...EMPTY_ENTITIES.aliases],
    },
    transcriptSegments: entry.transcriptSegments.map((segment) => ({ ...segment })),
  };
  if (resolved.videoId) {
    payload.id = resolved.videoId;
  }
  return payload;
}

function buildEntryPlan(entry, manifestDirectory) {
  const validation = validateEntry(entry, manifestDirectory);
  if (validation.issues.length > 0) {
    return {
      kind: 'rejected',
      sourceKey: entry?.sourceKey || '',
      title: entry?.title || '',
      issues: validation.issues,
    };
  }

  if (entry.import?.status === 'success' || entry.import?.draft?.status === 'success') {
    return {
      kind: 'skipped',
      sourceKey: entry.sourceKey,
      title: entry.title,
      reason: 'ALREADY_IMPORTED',
    };
  }

  const coverCloudPath = `cover/${entry.sourceKey}.jpg`;
  const videoCloudPath = `video/${entry.sourceKey}.mp4`;
  const actions = [];
  const coverFileId =
    entry.import?.cover?.status === 'success' && entry.import.cover.fileId
      ? entry.import.cover.fileId
      : `pending:${coverCloudPath}`;
  const videoFileId =
    entry.import?.video?.status === 'success' && entry.import.video.fileId
      ? entry.import.video.fileId
      : `pending:${videoCloudPath}`;

  if (!entry.import?.cover || entry.import.cover.status !== 'success') {
    actions.push({
      type: 'uploadCover',
      cloudPath: coverCloudPath,
      localPath: entry.prepared.cover,
    });
  }
  if (!entry.import?.video || entry.import.video.status !== 'success') {
    actions.push({
      type: 'uploadVideo',
      cloudPath: videoCloudPath,
      localPath: entry.prepared.media,
    });
  }
  actions.push({ type: 'upsertVideo' });

  return {
    kind: 'ready',
    sourceKey: entry.sourceKey,
    title: entry.title,
    brandName: entry.brandName,
    actions,
    draftPayload: buildDraftPayload(entry, {
      brandId: `brand:${entry.brandName}`,
      coverFileId,
      videoFileId,
      videoId: entry.import?.draft?.videoId,
    }),
  };
}

function buildImportPlan({ entries, manifestDirectory }) {
  const ready = [];
  const rejected = [];
  const skipped = [];

  for (const entry of entries) {
    const result = buildEntryPlan(entry, manifestDirectory);
    if (result.kind === 'ready') {
      ready.push(result);
    } else if (result.kind === 'rejected') {
      rejected.push(result);
    } else {
      skipped.push(result);
    }
  }
  return { ready, rejected, skipped };
}

module.exports = {
  buildDraftPayload,
  buildImportPlan,
  resolvePreparedFile,
};
