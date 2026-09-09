'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { TAB_BAR_LIST } = require('./tabs');

describe('TAB_BAR_LIST', () => {
  it('is four tabs in spec order', () => {
    assert.deepEqual(
      TAB_BAR_LIST.map((item) => item.text),
      ['讲解', '商城', '客服', '我的'],
    );
    assert.deepEqual(
      TAB_BAR_LIST.map((item) => item.pagePath),
      [
        'pages/index/index',
        'pages/shop/shop',
        'pages/contact/contact',
        'pages/mine/mine',
      ],
    );
  });
});
