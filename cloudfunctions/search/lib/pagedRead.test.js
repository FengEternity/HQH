'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadAllPages } = require('./pagedRead');

function pagesOf(fullPages, lastPage) {
  return async (skip, limit) => {
    const pageIndex = skip / limit;
    if (pageIndex < fullPages) {
      return Array.from({ length: limit }, (_, i) => skip + i);
    }
    if (pageIndex === fullPages) {
      return Array.from({ length: lastPage }, (_, i) => skip + i);
    }
    return [];
  };
}

describe('loadAllPages', () => {
  it('reads two and a half pages to the end', async () => {
    const { rows, truncated } = await loadAllPages(pagesOf(2, 300), { pageSize: 1000, hardCap: 5000 });
    assert.equal(rows.length, 2300);
    assert.equal(rows[2299], 2299);
    assert.equal(truncated, false);
  });

  it('reports truncated when the cap is reached with full pages', async () => {
    const { rows, truncated } = await loadAllPages(pagesOf(9, 0), { pageSize: 100, hardCap: 300 });
    assert.equal(rows.length, 300);
    assert.equal(truncated, true);
  });
});
