const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { assessPlaybackProfile } = require('./playbackProfile');

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

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(filePath, 'r');

  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }

  return hash.digest('hex');
}

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function resolvePreparedFile(manifestDirectory, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) {
    return null;
  }
  const root = path.resolve(manifestDirectory);
  const resolved = path.resolve(root, relativePath);
  if (!isInside(root, resolved)) {
    return null;
  }

  // 词法检查挡不住符号链接：prepared 目录里的链接可能指向仓库外的任意文件，
  // 上传前必须按真实路径再确认一次仍在同一个 prepared 根下。
  let realRoot;
  let realResolved;
  try {
    realRoot = fs.realpathSync(root);
    realResolved = fs.realpathSync(resolved);
  } catch {
    return null;
  }
  if (!isInside(realRoot, realResolved)) {
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
    const allowedFields = new Set([
      'videoCodec',
      'audioCodec',
      'hasAudio',
      'playback',
    ]);
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
    const playback = media.playback;
    const playbackFields = new Set([
      'videoCodec',
      'profile',
      'pixelFormat',
      'width',
      'height',
      'frameRate',
      'hasBFrames',
      'maxKeyframeGapSec',
      'fastStart',
      'hasAudio',
      'audioCodec',
      'compliant',
    ]);
    if (
      !playback ||
      typeof playback !== 'object' ||
      Array.isArray(playback) ||
      Object.keys(playback).some((field) => !playbackFields.has(field)) ||
      (typeof media.videoCodec === 'string' &&
        playback.videoCodec !== media.videoCodec) ||
      (typeof media.audioCodec === 'string' &&
        playback.audioCodec !== media.audioCodec) ||
      (typeof media.hasAudio === 'boolean' &&
        playback.hasAudio !== media.hasAudio) ||
      typeof playback.compliant !== 'boolean'
    ) {
      issues.push('PLAYBACK_INVALID');
    } else if (
      playback.compliant !== true ||
      !assessPlaybackProfile(playback).compliant
    ) {
      issues.push('PLAYBACK_NOT_COMPLIANT');
    }
  }
  if (!Array.isArray(entry?.transcriptSegments) || entry.transcriptSegments.length === 0) {
    issues.push('TRANSCRIPT_SEGMENTS_REQUIRED');
  } else {
    // 时长本身非法时无法判定上界，只做结构校验，避免叠加两个互相掩盖的原因码。
    const upperBound =
      typeof entry.durationSec === 'number' &&
      Number.isFinite(entry.durationSec) &&
      entry.durationSec > 0
        ? entry.durationSec
        : Infinity;
    let previousStartSec = -Infinity;
    let outOfRange = false;
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
      if (valid && endSec > upperBound) {
        outOfRange = true;
      }
      return !valid;
    });
    if (invalidSegment) {
      issues.push('TRANSCRIPT_SEGMENT_INVALID');
    } else if (outOfRange) {
      issues.push('TRANSCRIPT_SEGMENT_OUT_OF_RANGE');
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
  } else if (
    !/^[a-f0-9]{64}$/.test(String(entry?.prepared?.mediaSha256 || ''))
  ) {
    issues.push('PLAYBACK_MEDIA_BINDING_INVALID');
  } else if (hashFile(mediaPath) !== entry.prepared.mediaSha256) {
    issues.push('PLAYBACK_MEDIA_MISMATCH');
  }
  return { issues, coverPath, mediaPath };
}

// 云函数保存前会 trim 并丢弃空串；此处先归一并去重，dry-run 输出才等于云端最终存储值。
function normalizeTags(tags) {
  const normalized = new Set();
  for (const tag of tags) {
    const trimmed = String(tag).trim();
    if (trimmed) {
      normalized.add(trimmed);
    }
  }
  return [...normalized];
}

function buildDraftPayload(entry, resolved) {
  const payload = {
    title: entry.title,
    intro: entry.intro,
    brandId: resolved.brandId,
    modelName: entry.modelName || '',
    tags: normalizeTags(entry.tags),
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
