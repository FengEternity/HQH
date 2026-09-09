'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  sortShopProductsByUpdatedAtDesc,
  collectLinkShopProductIds,
  assertShopProductIdsExist,
  replaceVideoShopLinksAfterValidation,
  shouldReplaceVideoLinks,
} = require('./shopListAndLinks');

describe('sortShopProductsByUpdatedAtDesc', () => {
  it('orders by updatedAt descending without mutating input', () => {
    const rows = [
      { _id: 'a', updatedAt: 10 },
      { _id: 'b', updatedAt: 30 },
      { _id: 'c', updatedAt: 20 },
    ];
    const sorted = sortShopProductsByUpdatedAtDesc(rows);
    assert.deepEqual(
      sorted.map((row) => row._id),
      ['b', 'c', 'a'],
    );
    assert.equal(rows[0]._id, 'a');
  });

  it('treats missing updatedAt as 0', () => {
    const sorted = sortShopProductsByUpdatedAtDesc([
      { _id: 'old', updatedAt: 5 },
      { _id: 'none' },
    ]);
    assert.deepEqual(
      sorted.map((row) => row._id),
      ['old', 'none'],
    );
  });
});

describe('collectLinkShopProductIds', () => {
  it('dedupes and asserts link ids', () => {
    assert.deepEqual(collectLinkShopProductIds('v1', ['p1', ' p1 ', '', 'p2']), ['p1', 'p2']);
  });

  it('throws BAD_INPUT when videoId empty', () => {
    assert.throws(() => collectLinkShopProductIds('', ['p1']), (err) => err.code === 'BAD_INPUT');
  });
});

describe('assertShopProductIdsExist', () => {
  it('throws NOT_FOUND when any product is missing', async () => {
    await assert.rejects(
      () =>
        assertShopProductIdsExist(['p1', 'missing'], async (id) => (id === 'p1' ? { _id: id } : null)),
      (err) => err.code === 'NOT_FOUND',
    );
  });

  it('resolves when all products exist', async () => {
    await assertShopProductIdsExist(['p1', 'p2'], async (id) => ({ _id: id }));
  });
});

describe('replaceVideoShopLinksAfterValidation', () => {
  it('does not delete when a product id is missing', async () => {
    const ops = [];
    await assert.rejects(
      () =>
        replaceVideoShopLinksAfterValidation({
          videoId: 'v1',
          shopProductIds: ['p1', 'ghost'],
          getProduct: async (id) => (id === 'p1' ? { _id: id } : null),
          removeForVideo: async () => {
            ops.push('remove');
          },
          insertLinks: async () => {
            ops.push('insert');
          },
        }),
      (err) => err.code === 'NOT_FOUND',
    );
    assert.deepEqual(ops, []);
  });

  it('deletes then inserts only after all ids exist', async () => {
    const ops = [];
    await replaceVideoShopLinksAfterValidation({
      videoId: 'v1',
      shopProductIds: ['p2', 'p1', 'p1'],
      getProduct: async (id) => ({ _id: id }),
      removeForVideo: async (videoId) => {
        ops.push(`remove:${videoId}`);
      },
      insertLinks: async (videoId, ids) => {
        ops.push(`insert:${videoId}:${ids.join(',')}`);
      },
    });
    assert.deepEqual(ops, ['remove:v1', 'insert:v1:p2,p1']);
  });
});

describe('shouldReplaceVideoLinks', () => {
  it('ignores missing videoIds so links stay untouched', () => {
    assert.equal(shouldReplaceVideoLinks({}), false);
    assert.equal(shouldReplaceVideoLinks({ videoIds: null }), false);
  });

  it('treats explicit empty array as clear-all', () => {
    assert.equal(shouldReplaceVideoLinks({ videoIds: [] }), true);
  });
});
