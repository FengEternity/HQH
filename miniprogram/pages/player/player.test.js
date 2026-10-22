'use strict';

const fs = require('fs');
const path = require('path');
const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const pagePath = require.resolve('./player');
const apiPath = require.resolve('../../utils/api');

function loadPage({ catalog, shop }) {
  delete require.cache[pagePath];
  const api = require(apiPath);
  api.catalog = catalog;
  api.shop = shop;
  let definition;
  global.Page = (value) => {
    definition = value;
  };
  global.wx = {
    setNavigationBarTitle() {},
    showToast() {},
  };
  require(pagePath);
  return Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    updates: [],
    setData(next) {
      this.updates.push(next);
      this.data = Object.assign({}, this.data, next);
    },
  });
}

afterEach(() => {
  delete require.cache[pagePath];
});

describe('player page', () => {
  it('keeps the player shell mounted and paints video with products once', async () => {
    const wxml = fs.readFileSync(path.join(__dirname, 'player.wxml'), 'utf8');
    assert.equal(wxml.includes('wx:elif="{{video}}"'), false);
    assert.equal(wxml.includes('加载中'), false);

    let releaseShop;
    const shopGate = new Promise((resolve) => {
      releaseShop = resolve;
    });
    const page = loadPage({
      catalog: async () => ({
        video: { title: '四参数', tags: ['RTK'], brandName: '华测', intro: '简介' },
        videoUrl: 'https://example.com/a.mp4',
      }),
      shop: () => shopGate,
    });
    const pending = page.onLoad({ id: 'v1' });
    await Promise.resolve();
    assert.equal(page.updates.some((item) => item.src), false);

    releaseShop({ products: [{ _id: 'p1', name: '手簿', priceFen: 100 }] });
    await pending;

    const painted = page.updates.filter((item) => item.src);
    assert.equal(painted.length, 1);
    assert.equal(painted[0].video.title, '四参数');
    assert.equal(painted[0].shopProducts.length, 1);
    assert.equal(painted[0].shopProducts[0].priceYuan, '1.0');
    assert.equal(page.data.src, 'https://example.com/a.mp4');
  });
});
