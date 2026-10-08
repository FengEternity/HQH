'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { linkKey, assertLinkIds } = require('./videoShopLink');

describe('videoShopLink', () => {
  it('rejects empty videoId', () => {
    assert.throws(() => assertLinkIds('', 'sp1'), (err) => err.code === 'BAD_INPUT');
  });

  it('rejects empty shopProductId', () => {
    assert.throws(() => assertLinkIds('v1', ''), (err) => err.code === 'BAD_INPUT');
  });

  it('returns stable linkKey for two non-empty ids', () => {
    const key1 = linkKey('v1', 'sp1');
    const key2 = linkKey('v1', 'sp1');
    assert.equal(key1, key2);
    assert.equal(key1, 'v1\0sp1');
  });

  it('returns different linkKey when ids are swapped', () => {
    const forward = linkKey('v1', 'sp1');
    const swapped = linkKey('sp1', 'v1');
    assert.notEqual(forward, swapped);
  });
});
