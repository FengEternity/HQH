'use strict';

function fail(message) {
  const err = new Error(message);
  err.code = 'BAD_INPUT';
  throw err;
}

function linkKey(videoId, shopProductId) {
  return `${videoId}\0${shopProductId}`;
}

function assertLinkIds(videoId, shopProductId) {
  if (!String(videoId || '').trim()) {
    fail('videoId 必填');
  }
  if (!String(shopProductId || '').trim()) {
    fail('shopProductId 必填');
  }
}

module.exports = {
  linkKey,
  assertLinkIds,
};
