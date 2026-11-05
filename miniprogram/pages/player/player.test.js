'use strict';

const fs = require('fs');
const path = require('path');
const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const pagePath = require.resolve('./player');
const apiPath = require.resolve('../../utils/api');

function loadPage({ catalog, shop, agent }) {
  delete require.cache[pagePath];
  const api = require(apiPath);
  api.catalog = catalog;
  api.shop = shop;
  api.agent =
    agent ||
    (async () => {
      throw new Error('agent');
    });
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

  it('asks about the current video without sending an openid', async () => {
    const calls = [];
    let failed = false;
    const page = loadPage({
      catalog: async () => ({
        video: { title: '设站' },
        videoUrl: 'https://example.com/a.mp4',
      }),
      shop: async () => ({ products: [] }),
      agent: async (data) => {
        calls.push(data);
        if (data.action === 'videoDocHistory') return { ok: true, messages: [] };
        if (!failed) {
          failed = true;
          throw new Error('网络中断');
        }
        return { ok: true, messages: [{ id: 'm1', role: 'assistant', text: '先整平' }] };
      },
    });
    await page.onLoad({ id: 'vid-1' });
    page._currentTimeSec = 9;
    await page.onTabTap({ currentTarget: { dataset: { tab: 'ask' } } });
    assert.equal(calls[0].action, 'videoDocHistory');
    assert.equal(calls[0].videoId, 'vid-1');
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0], 'openid'), false);

    page.setData({ inputDraft: '  ' });
    await page.onAskSend();
    assert.equal(calls.some((item) => item.action === 'videoDocSend'), false);

    page.setData({ inputDraft: '怎么整平' });
    await page.onAskSend();
    assert.equal(page.data.askError, '网络中断');
    assert.equal(page.data.inputDraft, '怎么整平');
    await page.onAskSend();
    const sends = calls.filter((item) => item.action === 'videoDocSend');
    assert.equal(sends.length, 2);
    assert.equal(sends[0].videoId, 'vid-1');
    assert.equal(sends[0].text, '怎么整平');
    assert.equal(sends[0].currentTimeSec, 9);
    assert.equal(sends[0].requestId, sends[1].requestId);
    assert.equal(Object.prototype.hasOwnProperty.call(sends[0], 'openid'), false);
    assert.equal(page.data.messages[0].text, '先整平');
    assert.equal(page.data.inputDraft, '');
  });
});
