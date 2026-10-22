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
  ['edit/edit.js', 7],
  ['notify/notify.js', 3],
]);

function readPage(relativePath) {
  return fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
}

function unauthorizedBlocks(source) {
  const starts = [...source.matchAll(/if\s*\([^)]*\.code\s*===\s*['"]UNAUTHORIZED['"][^)]*\)\s*\{/g)];
  return starts.map((match) => {
    const openingBrace = match.index + match[0].lastIndexOf('{');
    let depth = 0;
    for (let index = openingBrace; index < source.length; index += 1) {
      if (source[index] === '{') {
        depth += 1;
      } else if (source[index] === '}') {
        depth -= 1;
        if (depth === 0) {
          return source.slice(openingBrace + 1, index);
        }
      }
    }
    throw new Error('unterminated UNAUTHORIZED branch');
  });
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
      'edit/edit.js',
      'notify/notify.js',
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
      const branches = unauthorizedBlocks(source);
      assert.equal(branches.length, expectedRoutes);
      for (const branch of branches) {
        assert.match(
          branch,
          /switchTab\(\{\s*url:\s*['"]\/pages\/mine\/mine['"]\s*\}\)/,
        );
      }
      assert.equal((mineRoutes || []).length, expectedRoutes);
    });
  }
});
