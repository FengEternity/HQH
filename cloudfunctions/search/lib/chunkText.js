'use strict';

const crypto = require('crypto');

function clean(value) {
  return String(value || '').trim();
}

function joinTags(tags) {
  if (Array.isArray(tags)) {
    return tags.map((tag) => clean(tag)).filter(Boolean).join(' ');
  }
  return clean(tags);
}

function transcriptOf(fields) {
  const transcript = clean(fields && fields.transcript);
  if (transcript) {
    return transcript;
  }
  const list = fields && fields.transcriptSegments;
  if (!Array.isArray(list)) {
    return '';
  }
  return list
    .map((item) => clean(item && item.text))
    .filter(Boolean)
    .join('\n');
}

function chunkSourceParts(fields) {
  const source = fields || {};
  return [
    clean(source.title),
    clean(source.intro),
    joinTags(source.tags),
    clean(source.brandName),
    clean(source.modelName),
    transcriptOf(source),
  ].filter(Boolean);
}

function chunkSourceText(fields) {
  return chunkSourceParts(fields).join('\n');
}

function contentHash(fields) {
  return crypto.createHash('sha256').update(chunkSourceText(fields), 'utf8').digest('hex');
}

const EMPTY_CONTENT_HASH = contentHash({});

function fitChunkText(fields, maxInputChars) {
  const parts = chunkSourceParts(fields);
  const transcript = transcriptOf(fields);
  const head = transcript ? parts.slice(0, -1).join('\n') : parts.join('\n');
  if (maxInputChars == null) {
    const text = parts.join('\n');
    return text ? { ok: true, text } : { ok: false, error: 'empty_text' };
  }
  const limit = Number(maxInputChars);
  if (!Number.isFinite(limit) || limit < 0) {
    return { ok: false, error: 'input_too_long' };
  }
  if (!transcript) {
    if (head.length <= limit) {
      return head ? { ok: true, text: head } : { ok: false, error: 'empty_text' };
    }
    return { ok: false, error: 'input_too_long' };
  }
  const separator = head ? 1 : 0;
  if (head.length + separator > limit) {
    return { ok: false, error: 'input_too_long' };
  }
  const room = limit - head.length - separator;
  const clipped = transcript.slice(0, room);
  if (!clipped) {
    return { ok: true, text: head };
  }
  return { ok: true, text: head ? `${head}\n${clipped}` : clipped };
}

module.exports = {
  EMPTY_CONTENT_HASH,
  chunkSourceText,
  contentHash,
  fitChunkText,
};
