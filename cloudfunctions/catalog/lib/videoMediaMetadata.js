'use strict';

const { badInput } = require('./videoKnowledge');

const ALLOWED_MEDIA_KEYS = ['videoCodec', 'audioCodec', 'hasAudio'];

function defaultMedia(previous) {
  const prevMedia = (previous && previous.media) || {};
  return {
    videoCodec: String(prevMedia.videoCodec || ''),
    audioCodec: String(prevMedia.audioCodec || ''),
    hasAudio: Boolean(prevMedia.hasAudio),
  };
}

function defaultDurationSec(previous) {
  const prev = previous && previous.durationSec;
  return typeof prev === 'number' && Number.isFinite(prev) ? prev : 0;
}

function normalizeMediaObject(raw) {
  if (!raw || typeof raw !== 'object') {
    throw badInput('media must be an object');
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_MEDIA_KEYS.includes(key)) {
      throw badInput(`unexpected media field: ${key}`);
    }
  }
  return {
    videoCodec: String(raw.videoCodec || '').toLowerCase(),
    audioCodec: String(raw.audioCodec || '').toLowerCase(),
    hasAudio: Boolean(raw.hasAudio),
  };
}

function normalizeDurationSec(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badInput('durationSec must be a finite number');
  }
  if (value < 0) {
    throw badInput('durationSec must be non-negative');
  }
  return Math.round(value * 10) / 10;
}

function normalizeVideoMedia(input, previous) {
  const hasDuration = input && Object.prototype.hasOwnProperty.call(input, 'durationSec');
  const hasMedia = input && Object.prototype.hasOwnProperty.call(input, 'media');

  if (!hasDuration && !hasMedia) {
    return {
      durationSec: defaultDurationSec(previous),
      media: defaultMedia(previous),
    };
  }

  const durationSec = hasDuration
    ? normalizeDurationSec(input.durationSec)
    : defaultDurationSec(previous);
  const media = hasMedia ? normalizeMediaObject(input.media) : defaultMedia(previous);

  return { durationSec, media };
}

module.exports = {
  normalizeVideoMedia,
};
