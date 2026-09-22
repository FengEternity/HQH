'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { TAB_BAR_LIST } = require('./tabs');

describe('TAB_BAR_LIST', () => {
  it('is three tabs in spec order without shop', () => {
    assert.deepEqual(
      TAB_BAR_LIST.map((item) => item.text),
      ['讲解', '客服', '我的'],
    );
    assert.deepEqual(
      TAB_BAR_LIST.map((item) => item.pagePath),
      [
        'pages/index/index',
        'pages/contact/contact',
        'pages/mine/mine',
      ],
    );
  });
});
