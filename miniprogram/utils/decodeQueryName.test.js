'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { decodeQueryName } = require('./decodeQueryName');

describe('decodeQueryName', () => {
  it('decodes percent-encoded Chinese names for navigation titles', () => {
    assert.equal(
      decodeQueryName('%E6%B5%B7%E6%98%9F%E6%98%9F'),
      '海星星',
    );
  });

  it('returns empty string for missing values', () => {
    assert.equal(decodeQueryName(undefined), '');
    assert.equal(decodeQueryName(''), '');
  });
});
