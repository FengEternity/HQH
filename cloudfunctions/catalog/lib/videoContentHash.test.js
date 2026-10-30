'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { contentHash } = require('./videoContentHash');
const { contentHash: searchHash } = require('../../search/lib/chunkText');

describe('videoContentHash', () => {
  it('matches the hash search stores on a chunk', () => {
    const fields = {
      title: '主机架设',
      intro: '怎么架设',
      tags: ['对中'],
      brandName: '中海达',
      modelName: 'iRTK5',
      transcript: '先整平再对中',
    };
    assert.equal(contentHash(fields), searchHash(fields));
    assert.notEqual(contentHash(fields), contentHash(Object.assign({}, fields, { intro: '改了' })));
  });
});
