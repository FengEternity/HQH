'use strict';

const { buildSearchBlob, expandQuery, scoreVideo, searchPublished } = require('./keywordSearch');

function withSearchBlob(video) {
  if (video && video.searchBlob) {
    return video;
  }
  return Object.assign({}, video, { searchBlob: buildSearchBlob(video || {}) });
}

function toVideoItem(video, score) {
  const item = {
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
  if (score != null) {
    item.score = score;
  }
  return item;
}

function applyPaging(items, limit, offset) {
  const list = Array.isArray(items) ? items : [];
  const off = Math.max(0, Number(offset) || 0);
  const lim = Number(limit);
  if (!Number.isFinite(lim) || lim <= 0) {
    return list.slice(off);
  }
  return list.slice(off, off + lim);
}

function emptyOk(scene) {
  return { ok: true, scene, mode: 'keyword', items: [], related: [] };
}

function runSearch(input) {
  const scene = input && input.scene;
  if (scene !== 'video' && scene !== 'product') {
    return { ok: false, code: 'BAD_INPUT', message: 'scene 必须是 video 或 product' };
  }
  if (scene === 'product') {
    return emptyOk(scene);
  }
  const query = input && input.query;
  if (!String(query || '').trim()) {
    return emptyOk(scene);
  }
  const synonyms = (input && input.synonyms) || [];
  const tokens = expandQuery(query, synonyms);
  const videos = ((input && input.videos) || []).map(withSearchBlob);
  const hits = searchPublished(videos, query, synonyms);
  const items = hits.map((video) => {
    const scored = scoreVideo(video, tokens);
    return toVideoItem(video, scored && scored.rank);
  });
  return {
    ok: true,
    scene,
    mode: 'keyword',
    items: applyPaging(items, input.limit, input.offset),
    related: [],
  };
}

module.exports = {
  runSearch,
};
