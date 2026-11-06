'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { CATALOG_TTL_MS, createCatalogCache, createReadCache, publishedFingerprint } = require('./searchCatalogCache');

describe('search catalog cache', () => {
  it('reuses chunks while the published fingerprint is unchanged', () => {
    const cache = createCatalogCache();
    const videos = [{ _id: 'b', status: 'published', contentHash: 'hb' }, { _id: 'a', status: 'published', contentHash: 'ha' }];
    const chunks = [{ sourceId: 'a' }, { sourceId: 'b' }];
    cache.write(videos, chunks, 1000);
    assert.deepEqual(cache.read(videos.slice().reverse(), 1000 + CATALOG_TTL_MS - 1), chunks);
  });

  it('misses after the content hash changes', () => {
    const cache = createCatalogCache();
    const videos = [{ _id: 'a', status: 'published', contentHash: 'old' }];
    cache.write(videos, [{ sourceId: 'a' }], 1000);
    const next = [{ _id: 'a', status: 'published', contentHash: 'new' }];
    assert.equal(cache.read(next, 1000), null);
    assert.notEqual(publishedFingerprint(videos), publishedFingerprint(next));
  });

  it('expires after one minute', () => {
    const cache = createCatalogCache();
    const videos = [{ _id: 'a', status: 'published', contentHash: 'h' }];
    cache.write(videos, [{ sourceId: 'a' }], 1000);
    assert.equal(cache.read(videos, 1000 + CATALOG_TTL_MS), null);
  });
});

describe('read cache', () => {
  it('serves the value for a minute and drops it on invalidate', () => {
    const cache = createReadCache({ ttlMs: 60000 });
    cache.write([{ _id: 'v1' }], 1000);
    assert.deepEqual(cache.read(1000 + 59999), [{ _id: 'v1' }]);
    assert.equal(cache.read(1000 + 60000), null);
    cache.write([{ _id: 'v2' }], 2000);
    cache.invalidate();
    assert.equal(cache.read(2000), null);
  });
});
