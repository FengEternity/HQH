'use strict';

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function entityText(fields) {
  const entities = fields && fields.entities;
  if (Array.isArray(entities)) {
    return entities.join(' ');
  }
  if (!entities || typeof entities !== 'object') {
    return '';
  }
  return ['models', 'actions', 'menus', 'aliases']
    .map((key) => (Array.isArray(entities[key]) ? entities[key].join(' ') : ''))
    .join(' ');
}

function segmentText(fields) {
  const list = fields && fields.transcriptSegments;
  if (!Array.isArray(list)) {
    return '';
  }
  return list.map((item) => (item && item.text) || '').join(' ');
}

function buildSearchBlob(fields) {
  const tags = Array.isArray(fields.tags) ? fields.tags.join(' ') : fields.tags || '';
  return normalize(
    [
      fields.title,
      fields.intro,
      fields.searchAbstract,
      fields.transcript,
      segmentText(fields),
      fields.brandName,
      fields.modelName,
      tags,
      entityText(fields),
    ].join(' '),
  );
}

function expandQuery(query, synonyms) {
  let expanded = normalize(query);
  if (!expanded) {
    return [];
  }
  const list = Array.isArray(synonyms) ? synonyms.slice() : [];
  list.sort((a, b) => normalize(b.alias).length - normalize(a.alias).length);
  for (const item of list) {
    const alias = normalize(item.alias);
    const canonical = normalize(item.canonical);
    if (!alias) {
      continue;
    }
    expanded = expanded.split(alias).join(canonical);
  }
  return expanded.split(' ').filter(Boolean);
}

function scoreVideo(video, tokens) {
  if (video.status !== 'published') {
    return null;
  }
  const blob = video.searchBlob || '';
  for (const token of tokens) {
    if (!blob.includes(token)) {
      return null;
    }
  }
  const title = normalize(video.title);
  const brand = normalize(video.brandName);
  const model = normalize(video.modelName);
  const phrase = tokens.join(' ');
  let rank = 1;
  if (title.includes(phrase) || tokens.every((token) => title.includes(token))) {
    rank = 3;
  } else if (tokens.some((token) => brand.includes(token) || model.includes(token))) {
    rank = 2;
  }
  return {
    rank,
    publishedAt: Number(video.publishedAt) || 0,
  };
}

function searchPublished(videos, query, synonyms) {
  const tokens = expandQuery(query, synonyms);
  if (tokens.length === 0) {
    return [];
  }
  return videos
    .map((video) => {
      const scored = scoreVideo(video, tokens);
      if (!scored) {
        return null;
      }
      return { video, rank: scored.rank, publishedAt: scored.publishedAt };
    })
    .filter(Boolean)
    .sort((a, b) => b.rank - a.rank || b.publishedAt - a.publishedAt)
    .map((row) => row.video);
}

module.exports = {
  normalize,
  buildSearchBlob,
  expandQuery,
  scoreVideo,
  searchPublished,
};
