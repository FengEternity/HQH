'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { searchNoticeText } = require('./searchNotice');

describe('searchNoticeText', () => {
  it('uses the two fixed sentences from the search contract', () => {
    assert.equal(searchNoticeText('', []), '');
    assert.equal(searchNoticeText('coverage_incomplete', []), '语义检索未覆盖全部讲解，结果可能不全');
    assert.equal(
      searchNoticeText('coverage_incomplete', [{ id: 'v1' }]),
      '语义检索未覆盖全部讲解，结果可能不全',
    );
    assert.equal(searchNoticeText('semantic_unavailable', []), '语义检索暂不可用');
    assert.equal(
      searchNoticeText('semantic_unavailable', [{ id: 'v1' }]),
      '语义检索暂不可用，以下为关键词结果',
    );
  });
});
