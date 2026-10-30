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

function contentHash(fields) {
  const source = fields || {};
  const text = [
    clean(source.title),
    clean(source.intro),
    joinTags(source.tags),
    clean(source.brandName),
    clean(source.modelName),
    transcriptOf(source),
  ]
    .filter(Boolean)
    .join('\n');
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

module.exports = {
  contentHash,
};
