'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  CATALOG_COLLECTIONS,
  isCollectionExistsError,
  isCollectionMissingError,
  ensureCollections,
  runWithCollections,
} = require('./ensureCollections');

describe('ensureCollections', () => {
  it('lists the five catalog collections plus shop_products and video_shop_links', () => {
    assert.deepEqual(CATALOG_COLLECTIONS, [
      'brands',
      'products',
      'videos',
      'synonyms',
      'support_messages',
      'shop_products',
      'video_shop_links',
    ]);
  });

  it('creates all catalog collections when none exist', async () => {
    const calls = [];
    const db = {
      createCollection: async (name) => {
        calls.push(name);
      },
    };
    const result = await ensureCollections(db);
    assert.deepEqual(calls, CATALOG_COLLECTIONS);
    assert.deepEqual(result.created, CATALOG_COLLECTIONS);
    assert.deepEqual(result.existed, []);
  });

  it('treats already-exists as success', async () => {
    const db = {
      createCollection: async (name) => {
        if (name === 'brands') {
          const err = new Error('collection already exists');
          err.errCode = -501001;
          throw err;
        }
      },
    };
    const result = await ensureCollections(db);
    assert.deepEqual(result.created, CATALOG_COLLECTIONS.filter((n) => n !== 'brands'));
    assert.deepEqual(result.existed, ['brands']);
  });

  it('does not treat collection-not-exist as already-exists', async () => {
    const db = {
      createCollection: async () => {
        const err = new Error('database collection not exists');
        err.errCode = -502005;
        throw err;
      },
    };
    await assert.rejects(() => ensureCollections(db), /not exists/);
  });

  it('rethrows unexpected create errors', async () => {
    const db = {
      createCollection: async () => {
        throw new Error('permission denied');
      },
    };
    await assert.rejects(() => ensureCollections(db), /permission denied/);
  });
});

describe('isCollectionExistsError', () => {
  it('matches already-exists messages, not missing-collection', () => {
    assert.equal(isCollectionExistsError({ errCode: -502005 }), false);
    assert.equal(isCollectionExistsError({ message: 'ResourceExist' }), true);
    assert.equal(isCollectionExistsError({ message: '集合已存在' }), true);
    assert.equal(isCollectionExistsError({ message: 'already exists' }), true);
    assert.equal(isCollectionExistsError({ message: 'permission denied' }), false);
  });
});

describe('isCollectionMissingError', () => {
  it('matches WeChat DATABASE_COLLECTION_NOT_EXIST', () => {
    assert.equal(
      isCollectionMissingError({
        errCode: -502005,
        message: 'database collection not exists. [ResourceNotFound] Db or Table not exist: videos',
      }),
      true,
    );
    assert.equal(isCollectionMissingError({ message: 'already exists' }), false);
  });
});

describe('runWithCollections', () => {
  it('creates missing collections then retries the read', async () => {
    let created = false;
    let reads = 0;
    const db = {
      createCollection: async () => {
        created = true;
      },
    };
    const result = await runWithCollections(db, async () => {
      reads += 1;
      if (!created) {
        const err = new Error('database collection not exists');
        err.errCode = -502005;
        throw err;
      }
      return { ok: true, videos: [] };
    });
    assert.equal(reads, 2);
    assert.deepEqual(result, { ok: true, videos: [] });
  });
});
