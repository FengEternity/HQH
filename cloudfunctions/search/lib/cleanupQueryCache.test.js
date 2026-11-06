'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { QUERY_CACHE_TTL_MS } = require('./queryEmbeddingCache');
const { cleanupQueryCache, QUERY_CACHE_RETIRE_MS } = require('./cleanupQueryCache');

function createDb(rows) {
  const docs = new Map(rows.map((row) => [row._id, row]));
  return {
    docs,
    collection(name) {
      assert.equal(name, 'search_query_cache');
      return {
        skip(skip) {
          return {
            limit(limit) {
              return {
                get: async () => ({ data: rows.slice(skip, skip + limit) }),
              };
            },
          };
        },
        doc(id) {
          return {
            remove: async () => {
              docs.delete(id);
            },
          };
        },
      };
    },
  };
}

describe('cleanupQueryCache', () => {
  it('removes rows beyond twice the ttl and keeps the rest', async () => {
    const now = 10 * QUERY_CACHE_TTL_MS;
    const db = createDb([
      { _id: 'fresh', updatedAt: now - 1000 },
      { _id: 'stale', updatedAt: now - QUERY_CACHE_RETIRE_MS - 1 },
      { _id: 'staler', updatedAt: 0 },
    ]);

    const result = await cleanupQueryCache({ db, now });

    assert.deepEqual(result, { ok: true, removed: 2, scanned: 3 });
    assert.deepEqual(Array.from(db.docs.keys()), ['fresh']);
  });

  it('keeps a row exactly at the retirement boundary', async () => {
    const now = 5000;
    const db = createDb([{ _id: 'edge', updatedAt: now - QUERY_CACHE_RETIRE_MS }]);

    const result = await cleanupQueryCache({ db, now });

    assert.deepEqual(result, { ok: true, removed: 0, scanned: 1 });
    assert.equal(db.docs.has('edge'), true);
  });
});
