'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { listHomeCatalog } = require('./listHome');

describe('listHomeCatalog', () => {
  it('returns brands and videos from one composed call', async () => {
    const out = await listHomeCatalog({
      listBrands: async () => ({ ok: true, brands: [{ _id: 'b1', name: '中海达' }] }),
      listPublished: async () => ({ ok: true, videos: [{ _id: 'v1', title: '架设' }] }),
    });
    assert.equal(out.ok, true);
    assert.equal(out.brands.length, 1);
    assert.equal(out.brands[0]._id, 'b1');
    assert.equal(out.videos.length, 1);
    assert.equal(out.videos[0]._id, 'v1');
  });

  it('overlaps both loaders instead of running them strictly in series', async () => {
    const started = [];
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    const t0 = Date.now();
    const out = await listHomeCatalog({
      listBrands: async () => {
        started.push('brands');
        await delay(40);
        return { ok: true, brands: [{ _id: 'b' }] };
      },
      listPublished: async () => {
        started.push('published');
        await delay(40);
        return { ok: true, videos: [{ _id: 'v' }] };
      },
    });
    const elapsed = Date.now() - t0;
    assert.deepEqual(started, ['brands', 'published']);
    assert.ok(elapsed < 70, `expected overlap (<70ms), got ${elapsed}ms`);
    assert.equal(out.brands[0]._id, 'b');
    assert.equal(out.videos[0]._id, 'v');
  });

  it('normalizes missing arrays to empty', async () => {
    const out = await listHomeCatalog({
      listBrands: async () => ({ ok: true }),
      listPublished: async () => ({ ok: true }),
    });
    assert.deepEqual(out.brands, []);
    assert.deepEqual(out.videos, []);
  });
});
