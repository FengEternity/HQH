'use strict';

function failUnpublishable(message) {
  const err = new Error(message);
  err.code = 'UNPUBLISHABLE';
  throw err;
}

function assertShopProductPublishable({ name, priceFen, coverFileId, status }) {
  if (status !== 'published') {
    return;
  }

  const trimmedName = String(name || '').trim();
  const trimmedCover = String(coverFileId || '').trim();

  if (!trimmedName) {
    failUnpublishable('名称必填');
  }
  if (!Number.isInteger(priceFen) || priceFen < 0) {
    failUnpublishable('价格无效');
  }
  if (!trimmedCover) {
    failUnpublishable('主图必填');
  }
}

module.exports = {
  assertShopProductPublishable,
};
