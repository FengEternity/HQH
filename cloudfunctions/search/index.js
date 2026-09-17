'use strict';

const cloud = require('wx-server-sdk');
const { runSearch } = require('./lib/searchIndex');
const { attachPosterUrls } = require('./lib/resolvePosterUrls');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

async function loadPublishedVideos() {
  const res = await db
    .collection('videos')
    .where({ status: 'published' })
    .field({
      title: true,
      intro: true,
      brandId: true,
      brandName: true,
      productId: true,
      modelName: true,
      tags: true,
      coverFileId: true,
      videoFileId: true,
      status: true,
      publishedAt: true,
      searchBlob: true,
      searchAbstract: true,
    })
    .limit(1000)
    .get();
  return res.data || [];
}

async function loadSynonyms() {
  const res = await db.collection('synonyms').limit(200).get();
  return res.data || [];
}

async function handle(event) {
  const scene = event && event.scene;
  if (scene !== 'video' && scene !== 'product') {
    return { ok: false, code: 'BAD_INPUT', message: 'scene 必须是 video 或 product' };
  }
  if (scene === 'product') {
    return runSearch({
      scene,
      query: event && event.query,
      limit: event && event.limit,
      offset: event && event.offset,
    });
  }
  const query = event && event.query;
  if (!String(query || '').trim()) {
    return runSearch({ scene, query });
  }
  const [videos, synonyms] = await Promise.all([loadPublishedVideos(), loadSynonyms()]);
  const result = runSearch({
    scene,
    query,
    videos,
    synonyms,
    limit: event && event.limit,
    offset: event && event.offset,
  });
  if (!result.ok || !result.items || !result.items.length) {
    return result;
  }
  result.items = await attachPosterUrls(result.items, (payload) => cloud.getTempFileURL(payload));
  return result;
}

exports.main = async (event) => {
  try {
    return await handle(event);
  } catch (error) {
    return {
      ok: false,
      code: error.code || 'FAIL',
      message: error.message || 'FAIL',
    };
  }
};
