'use strict';

const { assertLinkIds } = require('./videoShopLink');

function sortShopProductsByUpdatedAtDesc(rows) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  list.sort((a, b) => {
    const left = Number(a && a.updatedAt) || 0;
    const right = Number(b && b.updatedAt) || 0;
    return right - left;
  });
  return list;
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

function collectLinkShopProductIds(videoId, shopProductIds) {
  const ids = uniqueIds(shopProductIds);
  for (const shopProductId of ids) {
    assertLinkIds(videoId, shopProductId);
  }
  return ids;
}

async function assertShopProductIdsExist(ids, getProduct) {
  for (const shopProductId of ids) {
    const doc = await getProduct(shopProductId);
    if (!doc) {
      const err = new Error('商品不存在');
      err.code = 'NOT_FOUND';
      throw err;
    }
  }
}

async function replaceVideoShopLinksAfterValidation({
  videoId,
  shopProductIds,
  getProduct,
  removeForVideo,
  insertLinks,
}) {
  const ids = collectLinkShopProductIds(videoId, shopProductIds);
  await assertShopProductIdsExist(ids, getProduct);
  await removeForVideo(videoId);
  await insertLinks(videoId, ids);
}

module.exports = {
  sortShopProductsByUpdatedAtDesc,
  uniqueIds,
  collectLinkShopProductIds,
  assertShopProductIdsExist,
  replaceVideoShopLinksAfterValidation,
};
