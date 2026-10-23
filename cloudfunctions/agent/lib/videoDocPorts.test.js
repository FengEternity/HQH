'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadVideoDoc, loadLinkedVideoProducts } = require('./videoDocPorts');

function createDb() {
  const tables = {
    videos: [{ _id: 'vid-1', status: 'published', title: '设站', intro: '先整平', transcript: '原文', secret: '机密' }],
    video_shop_links: [{ videoId: 'vid-1', shopProductId: 'sku-1' }, { videoId: 'vid-1', shopProductId: 'missing' }],
    shop_products: [{ _id: 'sku-1', name: '脚架', priceFen: 100, status: 'published', detail: '内部说明' }],
  };
  return {
    collection(name) {
      return {
        doc(id) {
          return {
            get: async () => {
              const doc = tables[name].find((item) => item._id === id);
              if (!doc) {
                const error = new Error('not found');
                throw error;
              }
              return { data: doc };
            },
          };
        },
        where(query) {
          return {
            get: async () => ({
              data: tables[name].filter((row) =>
                Object.keys(query).every((key) => row[key] === query[key]),
              ),
            }),
          };
        },
      };
    },
  };
}

describe('videoDocPorts', () => {
  it('returns the published video fields and skips a missing product', async () => {
    const db = createDb();
    const video = await loadVideoDoc(db, 'vid-1');
    assert.equal(video.title, '设站');
    assert.equal(video.transcript, '原文');
    assert.equal(video.secret, undefined);
    const products = await loadLinkedVideoProducts(db, 'vid-1');
    assert.deepEqual(products, [{ id: 'sku-1', name: '脚架', priceFen: 100, status: 'published' }]);
    assert.equal(await loadVideoDoc(db, 'gone'), null);
  });
});
