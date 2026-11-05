'use strict';

async function loadVideoDoc(db, videoId) {
  const id = String(videoId || '').trim();
  if (!id) return null;
  let snap;
  try {
    snap = await db.collection('videos').doc(id).get();
  } catch (error) {
    return null;
  }
  const doc = snap && snap.data;
  if (!doc) return null;
  return {
    status: doc.status,
    title: doc.title,
    intro: doc.intro,
    tags: doc.tags,
    brandName: doc.brandName,
    modelName: doc.modelName,
    transcript: doc.transcript || '',
  };
}

async function loadLinkedVideoProducts(db, videoId) {
  const id = String(videoId || '').trim();
  if (!id) return [];
  const linkRes = await db.collection('video_shop_links').where({ videoId: id }).get();
  const products = [];
  for (const link of linkRes.data || []) {
    let snap;
    try {
      snap = await db.collection('shop_products').doc(link.shopProductId).get();
    } catch (error) {
      continue;
    }
    const doc = snap && snap.data;
    if (!doc) continue;
    products.push({
      id: doc._id,
      name: doc.name,
      priceFen: doc.priceFen,
      status: doc.status,
    });
  }
  return products;
}

module.exports = { loadVideoDoc, loadLinkedVideoProducts };
