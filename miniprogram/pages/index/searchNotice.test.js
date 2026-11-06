'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { searchNoticeText } = require('./searchNotice');

describe('searchNoticeText', () => {
  it('uses the two fixed sentences from the search contract', () => {
    assert.equal(searchNoticeText('', []), '');
    assert.equal(searchNoticeText('coverage_incomplete', []), '还有讲解不能按描述来找，结果可能不全');
    assert.equal(
      searchNoticeText('coverage_incomplete', [{ id: 'v1' }]),
      '还有讲解不能按描述来找，结果可能不全',
    );
    assert.equal(searchNoticeText('semantic_unavailable', []), '按描述来找暂时不可用');
    assert.equal(
      searchNoticeText('semantic_unavailable', [{ id: 'v1' }]),
      '按描述来找暂时不可用，以下是按名称找到的',
    );
  });

  it('tells the visitor only part of the library was searched', () => {
    assert.equal(searchNoticeText('library_overflow', []), '讲解较多，本次只搜到其中一部分');
    assert.equal(searchNoticeText('library_overflow', [{ id: 'v1' }]), '讲解较多，本次只搜到其中一部分');
  });
});
