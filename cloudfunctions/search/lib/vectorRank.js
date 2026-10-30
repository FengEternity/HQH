'use strict';

const { EMBEDDING_DIM, EMBEDDING_MODEL } = require('./searchConfig');
const { EMPTY_CONTENT_HASH } = require('./chunkText');

function magnitudeSquared(vector) {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  return sum;
}

function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function usableChunk(video, chunk, modelName) {
  if (!video || !chunk || chunk.status !== 'ready') {
    return false;
  }
  if (!video.contentHash || chunk.contentHash !== video.contentHash) {
    return false;
  }
  if (chunk.embeddingModel !== modelName) {
    return false;
  }
  if (!Array.isArray(chunk.embedding) || chunk.embedding.length !== EMBEDDING_DIM) {
    return false;
  }
  return magnitudeSquared(chunk.embedding) > 0;
}

function selectVectorHits({ videos, chunks, queryEmbedding, threshold, model }) {
  const modelName = model || EMBEDDING_MODEL;
  const byId = new Map();
  for (const chunk of chunks || []) {
    if (chunk && chunk.sourceId) {
      byId.set(String(chunk.sourceId), chunk);
    }
  }
  let expected = 0;
  let indexed = 0;
  const hits = [];
  for (const video of videos || []) {
    if (!video || video.status !== 'published') {
      continue;
    }
    const hash = video.contentHash || '';
    if (!hash || hash !== EMPTY_CONTENT_HASH) {
      expected += 1;
    }
    const chunk = byId.get(String(video._id));
    if (!usableChunk(video, chunk, modelName)) {
      continue;
    }
    indexed += 1;
    const score = cosine(queryEmbedding, chunk.embedding);
    if (!(score >= threshold)) {
      continue;
    }
    hits.push({ video, cosine: score });
  }
  hits.sort((left, right) => {
    if (right.cosine !== left.cosine) {
      return right.cosine - left.cosine;
    }
    const publishedDelta = (Number(right.video.publishedAt) || 0) - (Number(left.video.publishedAt) || 0);
    if (publishedDelta !== 0) {
      return publishedDelta;
    }
    return String(left.video._id).localeCompare(String(right.video._id));
  });
  return {
    expected,
    hits: hits.slice(0, 8),
    indexed,
  };
}

function scorePublishedVideos({ videos, chunks, queryEmbedding, model }) {
  const modelName = model || EMBEDDING_MODEL;
  const byId = new Map();
  for (const chunk of chunks || []) {
    if (chunk && chunk.sourceId) {
      byId.set(String(chunk.sourceId), chunk);
    }
  }
  const rows = [];
  let published = 0;
  for (const video of videos || []) {
    if (!video || video.status !== 'published') {
      continue;
    }
    published += 1;
    const chunk = byId.get(String(video._id));
    if (!usableChunk(video, chunk, modelName)) {
      continue;
    }
    rows.push({
      id: String(video._id),
      title: String(video.title || ''),
      cosine: cosine(queryEmbedding, chunk.embedding),
      publishedAt: Number(video.publishedAt) || 0,
    });
  }
  rows.sort((left, right) => {
    if (right.cosine !== left.cosine) {
      return right.cosine - left.cosine;
    }
    if (right.publishedAt !== left.publishedAt) {
      return right.publishedAt - left.publishedAt;
    }
    return left.id.localeCompare(right.id);
  });
  return {
    published,
    scored: rows.length,
    items: rows.map((row) => ({
      id: row.id,
      title: row.title,
      cosine: Math.round(row.cosine * 10000) / 10000,
    })),
  };
}

module.exports = {
  cosine,
  scorePublishedVideos,
  selectVectorHits,
};
