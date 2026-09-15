'use strict';

function publicVideo(doc) {
  if (!doc) {
    return null;
  }
  return {
    _id: doc._id,
    title: doc.title,
    intro: doc.intro,
    brandId: doc.brandId,
    brandName: doc.brandName,
    productId: doc.productId || '',
    modelName: doc.modelName || '',
    tags: doc.tags || [],
    coverFileId: doc.coverFileId || '',
    videoFileId: doc.videoFileId || '',
    searchAbstract: doc.searchAbstract || '',
    entities: doc.entities || { models: [], actions: [], menus: [], aliases: [] },
    status: doc.status,
    publishedAt: doc.publishedAt || 0,
  };
}

module.exports = { publicVideo };
