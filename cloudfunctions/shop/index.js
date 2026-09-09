'use strict';

const cloud = require('wx-server-sdk');
const { verifyTicket } = require('./lib/ticket');
const { assertShopProductPublishable } = require('./lib/shopPublishGate');
const { assertLinkIds, linkKey } = require('./lib/videoShopLink');
const { ensureCollections, runWithCollections } = require('./lib/ensureShopCollections');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

function publicShopProduct(doc) {
  if (!doc) {
    return null;
  }
  return {
    _id: doc._id,
    name: doc.name,
    priceFen: doc.priceFen,
    coverFileId: doc.coverFileId || '',
    detail: doc.detail || '',
    specName: doc.specName || '',
    specValue: doc.specValue || '',
    category: doc.category || '',
    status: doc.status,
    createdAt: doc.createdAt || 0,
    updatedAt: doc.updatedAt || 0,
  };
}

function publicVideoBrief(doc) {
  if (!doc) {
    return null;
  }
  return {
    _id: doc._id,
    title: doc.title,
    intro: doc.intro || '',
    brandId: doc.brandId || '',
    brandName: doc.brandName || '',
    coverFileId: doc.coverFileId || '',
    status: doc.status,
  };
}

async function requireAdmin(ticket) {
  const pin = process.env.ADMIN_PIN;
  if (!verifyTicket(pin, ticket)) {
    const err = new Error('UNAUTHORIZED');
    err.code = 'UNAUTHORIZED';
    throw err;
  }
}

function parsePriceFen(value) {
  if (Number.isInteger(value) && value >= 0) {
    return value;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return NaN;
  }
  return Math.round(n);
}

function uniqueIds(ids) {
  const seen = Object.create(null);
  const out = [];
  for (const raw of ids || []) {
    const id = String(raw || '').trim();
    if (!id || seen[id]) {
      continue;
    }
    seen[id] = true;
    out.push(id);
  }
  return out;
}

async function removeLinksWhere(where) {
  const res = await db.collection('video_shop_links').where(where).limit(1000).get();
  for (const row of res.data || []) {
    await db.collection('video_shop_links').doc(row._id).remove();
  }
}

async function insertVideoShopLinks(videoId, shopProductIds) {
  const ids = uniqueIds(shopProductIds);
  for (const shopProductId of ids) {
    assertLinkIds(videoId, shopProductId);
    const snap = await db.collection('shop_products').doc(shopProductId).get();
    if (!snap.data) {
      const err = new Error('商品不存在');
      err.code = 'NOT_FOUND';
      throw err;
    }
  }
  const seen = Object.create(null);
  for (const shopProductId of ids) {
    const key = linkKey(videoId, shopProductId);
    if (seen[key]) {
      continue;
    }
    seen[key] = true;
    await db.collection('video_shop_links').add({
      data: {
        videoId,
        shopProductId,
        createdAt: Date.now(),
      },
    });
  }
}

async function replaceLinksForShopProduct(shopProductId, videoIds) {
  const ids = uniqueIds(videoIds);
  for (const videoId of ids) {
    assertLinkIds(videoId, shopProductId);
  }
  await removeLinksWhere({ shopProductId });
  const seen = Object.create(null);
  for (const videoId of ids) {
    const key = linkKey(videoId, shopProductId);
    if (seen[key]) {
      continue;
    }
    seen[key] = true;
    await db.collection('video_shop_links').add({
      data: {
        videoId,
        shopProductId,
        createdAt: Date.now(),
      },
    });
  }
}

async function dispatch(event) {
  const action = event && event.action;
  switch (action) {
    case 'ping':
      return { ok: true };
    case 'listPublishedShop':
      return await listPublishedShop();
    case 'getPublishedShop':
      return await getPublishedShop(event);
    case 'listLinkedShopProducts':
      return await listLinkedShopProducts(event);
    case 'listLinkedVideos':
      return await listLinkedVideos(event);
    case 'upsertShopProduct':
      return await upsertShopProduct(event);
    case 'setShopProductStatus':
      return await setShopProductStatus(event);
    case 'setVideoShopLinks':
      return await setVideoShopLinks(event);
    case 'listShopAdmin':
      return await listShopAdmin(event);
    default: {
      const err = new Error('UNKNOWN_ACTION');
      err.code = 'UNKNOWN_ACTION';
      throw err;
    }
  }
}

exports.main = async (event) => {
  try {
    const action = event && event.action;
    if (action === 'ping') {
      return await dispatch(event);
    }
    return await runWithCollections(db, () => dispatch(event));
  } catch (error) {
    return {
      ok: false,
      code: error.code || 'FAIL',
      message: error.message || 'FAIL',
    };
  }
};

async function listPublishedShop() {
  const res = await db
    .collection('shop_products')
    .where({ status: 'published' })
    .orderBy('updatedAt', 'desc')
    .limit(100)
    .get();
  return { ok: true, products: (res.data || []).map(publicShopProduct) };
}

async function getPublishedShop(event) {
  const id = String((event && event.id) || '').trim();
  if (!id) {
    const err = new Error('NOT_FOUND');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const snap = await db.collection('shop_products').doc(id).get();
  const doc = snap.data;
  if (!doc || doc.status !== 'published') {
    const err = new Error('NOT_FOUND');
    err.code = 'NOT_FOUND';
    throw err;
  }
  return { ok: true, product: publicShopProduct(doc) };
}

async function listLinkedShopProducts(event) {
  const videoId = String((event && event.videoId) || '').trim();
  if (!videoId) {
    const err = new Error('videoId 必填');
    err.code = 'BAD_INPUT';
    throw err;
  }
  const linkRes = await db.collection('video_shop_links').where({ videoId }).limit(200).get();
  const products = [];
  for (const link of linkRes.data || []) {
    const snap = await db.collection('shop_products').doc(link.shopProductId).get();
    const doc = snap.data;
    if (doc && doc.status === 'published') {
      products.push(publicShopProduct(doc));
    }
  }
  return { ok: true, products };
}

async function listLinkedVideos(event) {
  const shopProductId = String((event && event.shopProductId) || '').trim();
  if (!shopProductId) {
    const err = new Error('shopProductId 必填');
    err.code = 'BAD_INPUT';
    throw err;
  }
  const linkRes = await db.collection('video_shop_links').where({ shopProductId }).limit(200).get();
  const videos = [];
  for (const link of linkRes.data || []) {
    const snap = await db.collection('videos').doc(link.videoId).get();
    const doc = snap.data;
    if (doc && doc.status === 'published') {
      videos.push(publicVideoBrief(doc));
    }
  }
  return { ok: true, videos };
}

async function upsertShopProduct(event) {
  await requireAdmin(event.ticket);
  const name = String(event.name || '').trim();
  const detail = String(event.detail || '').trim();
  const coverFileId = String(event.coverFileId || '').trim();
  const specName = String(event.specName || '').trim();
  const specValue = String(event.specValue || '').trim();
  const category = String(event.category || '').trim();
  const priceFen = parsePriceFen(event.priceFen);
  let status = String(event.status || 'unpublished').trim();
  if (status !== 'published') {
    status = 'unpublished';
  }

  const prev = event.id ? (await db.collection('shop_products').doc(event.id).get()).data : null;
  if (event.id && !prev) {
    const err = new Error('NOT_FOUND');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const payload = {
    name,
    priceFen: Number.isInteger(priceFen) ? priceFen : prev ? prev.priceFen : 0,
    coverFileId: coverFileId || (prev && prev.coverFileId) || '',
    detail,
    specName,
    specValue,
    category,
    status,
    updatedAt: Date.now(),
  };

  if (!Number.isInteger(payload.priceFen) || payload.priceFen < 0) {
    const err = new Error('价格无效');
    err.code = 'BAD_INPUT';
    throw err;
  }

  assertShopProductPublishable(payload);

  let id = event.id;
  if (id) {
    await db.collection('shop_products').doc(id).update({ data: payload });
  } else {
    payload.createdAt = Date.now();
    const added = await db.collection('shop_products').add({ data: payload });
    id = added._id;
  }

  if (Array.isArray(event.videoIds)) {
    await replaceLinksForShopProduct(id, event.videoIds);
  }

  return { ok: true, id };
}

async function setShopProductStatus(event) {
  await requireAdmin(event.ticket);
  const id = String(event.id || '').trim();
  let status = String(event.status || '').trim();
  if (status !== 'published' && status !== 'unpublished') {
    const err = new Error('状态无效');
    err.code = 'BAD_INPUT';
    throw err;
  }
  const snap = await db.collection('shop_products').doc(id).get();
  const doc = snap.data;
  if (!doc) {
    const err = new Error('NOT_FOUND');
    err.code = 'NOT_FOUND';
    throw err;
  }
  assertShopProductPublishable({
    name: doc.name,
    priceFen: doc.priceFen,
    coverFileId: doc.coverFileId,
    status,
  });
  await db.collection('shop_products').doc(id).update({
    data: {
      status,
      updatedAt: Date.now(),
    },
  });
  return { ok: true };
}

async function setVideoShopLinks(event) {
  await requireAdmin(event.ticket);
  const videoId = String(event.videoId || '').trim();
  if (!videoId) {
    const err = new Error('videoId 必填');
    err.code = 'BAD_INPUT';
    throw err;
  }
  const shopProductIds = Array.isArray(event.shopProductIds) ? event.shopProductIds : [];
  await removeLinksWhere({ videoId });
  await insertVideoShopLinks(videoId, shopProductIds);
  return { ok: true };
}

async function listShopAdmin(event) {
  await requireAdmin(event.ticket);
  const [productRes, linkRes, videoRes] = await Promise.all([
    db.collection('shop_products').orderBy('updatedAt', 'desc').limit(200).get(),
    db.collection('video_shop_links').limit(1000).get(),
    db
      .collection('videos')
      .field({
        title: true,
        brandId: true,
        brandName: true,
        status: true,
        coverFileId: true,
        updatedAt: true,
      })
      .orderBy('updatedAt', 'desc')
      .limit(500)
      .get(),
  ]);

  const linksByProduct = Object.create(null);
  for (const link of linkRes.data || []) {
    const pid = link.shopProductId;
    if (!linksByProduct[pid]) {
      linksByProduct[pid] = [];
    }
    linksByProduct[pid].push(link.videoId);
  }

  const products = (productRes.data || []).map((doc) =>
    Object.assign({}, publicShopProduct(doc), {
      videoIds: uniqueIds(linksByProduct[doc._id] || []),
    }),
  );

  const videos = (videoRes.data || []).map((doc) => ({
    _id: doc._id,
    title: doc.title,
    brandName: doc.brandName || '',
    status: doc.status,
    coverFileId: doc.coverFileId || '',
  }));

  return { ok: true, products, videos };
}

// ensureCollections kept available for local smoke if needed
module.exports.ensureCollections = ensureCollections;
module.exports.publicShopProduct = publicShopProduct;
