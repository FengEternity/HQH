'use strict';

const { expandQuery } = require('./keywordSearch');

const FIND_VIDEOS_CARD_CAP = 8;

function toCard(video) {
  return {
    id: video._id,
    title: video.title || '',
    brandName: video.brandName || '',
    brandId: video.brandId || '',
    modelName: video.modelName || '',
    tags: Array.isArray(video.tags) ? video.tags : [],
    summary: video.intro || video.searchAbstract || '',
    coverFileId: video.coverFileId || '',
  };
}

function findVideos(videos, query, synonyms) {
  const phrase = expandQuery(query, synonyms).join(' ');
  if (!phrase) {
    return [];
  }
  const cards = [];
  for (const video of videos || []) {
    if (!video || video.status !== 'published') {
      continue;
    }
    const blob = video.searchBlob || '';
    if (!blob.includes(phrase)) {
      continue;
    }
    cards.push(toCard(video));
    if (cards.length >= FIND_VIDEOS_CARD_CAP) {
      break;
    }
  }
  return cards;
}

module.exports = {
  FIND_VIDEOS_CARD_CAP,
  findVideos,
};
