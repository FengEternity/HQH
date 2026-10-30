'use strict';

const { buildSearchBlob, searchPublished } = require('./keywordSearch');
const {
  COSINE_THRESHOLD,
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  VECTOR_CAP,
} = require('./searchConfig');
const { decideNotice, mergeVideos } = require('./mergeNotice');
const { selectVectorHits } = require('./vectorRank');

function withSearchBlob(video) {
  if (video && video.searchBlob) {
    return video;
  }
  return Object.assign({}, video, { searchBlob: buildSearchBlob(video || {}) });
}

function toVideoItem(video) {
  return {
    type: 'video',
    id: video._id,
    title: video.title || '',
    coverFileId: video.coverFileId || '',
    summary: video.intro || video.searchAbstract || '',
    brandName: video.brandName || '',
    brandId: video.brandId || '',
    modelName: video.modelName || '',
    tags: Array.isArray(video.tags) ? video.tags : [],
  };
}

function runSearch(input) {
  const scene = input && input.scene;
  if (scene !== 'video' && scene !== 'product') {
    return { ok: false, code: 'BAD_INPUT' };
  }
  if (scene === 'product') {
    return { ok: true, scene, items: [] };
  }
  const query = input && input.query;
  if (!String(query || '').trim()) {
    return { ok: true, scene, items: [] };
  }
  const synonyms = (input && input.synonyms) || [];
  const videos = ((input && input.videos) || []).map(withSearchBlob);
  const keywordHits = searchPublished(videos, query, synonyms);
  const published = videos.filter((video) => video && video.status === 'published');
  const threshold = input && Object.prototype.hasOwnProperty.call(input, 'threshold')
    ? input.threshold
    : COSINE_THRESHOLD;
  const vectorEnabled = typeof threshold === 'number' && Number.isFinite(threshold);
  const overCap = published.length > VECTOR_CAP;
  let embedError = Boolean(input && input.embedError);
  let indexed = 0;
  let expected = 0;
  let vectorHits = [];
  if (vectorEnabled && !overCap && !embedError && published.length > 0) {
    const queryEmbedding = input && input.queryEmbedding;
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length !== EMBEDDING_DIM) {
      embedError = true;
    } else {
      const ranked = selectVectorHits({
        videos: published,
        chunks: input.chunks || [],
        queryEmbedding,
        threshold,
        model: (input && input.embeddingModel) || EMBEDDING_MODEL,
      });
      indexed = ranked.indexed;
      expected = ranked.expected;
      vectorHits = ranked.hits;
    }
  }
  const notice = decideNotice({
    publishedCount: published.length,
    vectorEnabled,
    embedError: vectorEnabled && embedError,
    overCap: vectorEnabled && overCap,
    indexed,
    expected,
  });
  const usableVectorHits = vectorEnabled && !embedError && !overCap ? vectorHits : [];
  const result = {
    ok: true,
    scene,
    items: mergeVideos(keywordHits, usableVectorHits).map(toVideoItem),
  };
  if (notice) {
    result.notice = notice;
  }
  return result;
}

module.exports = {
  runSearch,
};
