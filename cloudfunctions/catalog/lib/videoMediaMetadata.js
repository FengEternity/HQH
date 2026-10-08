'use strict';

const { badInput } = require('./videoKnowledge');

const ALLOWED_MEDIA_KEYS = ['videoCodec', 'audioCodec', 'hasAudio', 'playback'];
const PLAYBACK_STRING_KEYS = [
  'videoCodec',
  'profile',
  'pixelFormat',
  'audioCodec',
];
const PLAYBACK_NUMBER_KEYS = [
  'width',
  'height',
  'frameRate',
  'maxKeyframeGapSec',
];
const PLAYBACK_BOOLEAN_KEYS = [
  'hasBFrames',
  'fastStart',
  'hasAudio',
  'compliant',
];
const PLAYBACK_KEYS = [
  ...PLAYBACK_STRING_KEYS,
  ...PLAYBACK_NUMBER_KEYS,
  ...PLAYBACK_BOOLEAN_KEYS,
];

function clonePlayback(playback) {
  return playback && typeof playback === 'object' ? { ...playback } : undefined;
}

function defaultMedia(previous) {
  const prevMedia = (previous && previous.media) || {};
  const media = {
    videoCodec: String(prevMedia.videoCodec || ''),
    audioCodec: String(prevMedia.audioCodec || ''),
    hasAudio: Boolean(prevMedia.hasAudio),
  };
  const playback = clonePlayback(prevMedia.playback);
  if (playback) {
    media.playback = playback;
  }
  return media;
}

function defaultDurationSec(previous) {
  const prev = previous && previous.durationSec;
  return typeof prev === 'number' && Number.isFinite(prev) ? prev : 0;
}

function normalizePlayback(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw badInput('playback must be an object');
  }
  const keys = Object.keys(raw);
  if (
    keys.length !== PLAYBACK_KEYS.length ||
    keys.some((key) => !PLAYBACK_KEYS.includes(key))
  ) {
    throw badInput('playback fields must match the contract');
  }
  for (const key of PLAYBACK_STRING_KEYS) {
    if (typeof raw[key] !== 'string') {
      throw badInput(`${key} must be a string`);
    }
  }
  for (const key of PLAYBACK_NUMBER_KEYS) {
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) {
      throw badInput(`${key} must be a finite number`);
    }
  }
  for (const key of PLAYBACK_BOOLEAN_KEYS) {
    if (typeof raw[key] !== 'boolean') {
      throw badInput(`${key} must be a boolean`);
    }
  }
  if (raw.compliant !== true) {
    throw badInput('playback must be compliant');
  }
  return { ...raw };
}

function normalizeMediaObject(raw, previous, allowPlaybackUpdate) {
  if (!raw || typeof raw !== 'object') {
    throw badInput('media must be an object');
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_MEDIA_KEYS.includes(key)) {
      throw badInput(`unexpected media field: ${key}`);
    }
  }
  let hasAudio = false;
  if (Object.prototype.hasOwnProperty.call(raw, 'hasAudio')) {
    if (typeof raw.hasAudio !== 'boolean') {
      throw badInput('hasAudio must be a boolean');
    }
    hasAudio = raw.hasAudio;
  }
  const media = {
    videoCodec: String(raw.videoCodec || '').toLowerCase(),
    audioCodec: String(raw.audioCodec || '').toLowerCase(),
    hasAudio,
  };
  const previousPlayback = clonePlayback(previous?.media?.playback);
  if (Object.prototype.hasOwnProperty.call(raw, 'playback')) {
    const normalized = normalizePlayback(raw.playback);
    if (allowPlaybackUpdate) {
      media.playback = normalized;
    } else if (previousPlayback) {
      media.playback = previousPlayback;
    }
  } else if (previousPlayback) {
    media.playback = previousPlayback;
  }
  return media;
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

function normalizeVideoMedia(input, previous, options = {}) {
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
  const media = hasMedia
    ? normalizeMediaObject(
        input.media,
        previous,
        options.allowPlaybackUpdate !== false,
      )
    : defaultMedia(previous);

  return { durationSec, media };
}

module.exports = {
  normalizeVideoMedia,
};
