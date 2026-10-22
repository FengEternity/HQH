'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const affectedPages = new Map([
  ['catalog/catalog.js', 2],
  ['brand/brand.js', 3],
  ['videos/videos.js', 4],
  ['ingest/ingest.js', 2],
  ['shop/shop.js', 3],
  ['shop-edit/shop-edit.js', 2],
  ['inbox/inbox.js', 2],
  ['ticket/ticket.js', 3],
]);

function readPage(relativePath) {
  return fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
}

describe('admin unauthorized fallback', () => {
  it('covers the exact affected admin page set', () => {
    assert.deepEqual([...affectedPages.keys()], [
      'catalog/catalog.js',
      'brand/brand.js',
      'videos/videos.js',
      'ingest/ingest.js',
      'shop/shop.js',
      'shop-edit/shop-edit.js',
      'inbox/inbox.js',
      'ticket/ticket.js',
    ]);
  });

  for (const [relativePath, expectedRoutes] of affectedPages) {
    it(`${relativePath} sends every unauthorized path to mine`, () => {
      const source = readPage(relativePath);
      const mineRoutes = source.match(
        /switchTab\(\{\s*url:\s*['"]\/pages\/mine\/mine['"]\s*\}\)/g,
      );

      assert.doesNotMatch(
        source,
        /redirectTo\(\{\s*url:\s*['"]\/pages\/admin\/login\/login['"]\s*\}\)/,
      );
      assert.equal((mineRoutes || []).length, expectedRoutes);
    });
  }
});
