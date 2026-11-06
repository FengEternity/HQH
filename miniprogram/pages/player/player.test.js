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
  it('fetches a fresh video address after playback fails once', async () => {
    const calls = [];
    const page = loadPage({
      catalog: async (data) => {
        calls.push(data);
        return {
          video: { title: '设站' },
          videoUrl: calls.length === 1 ? 'https://example.com/old.mp4' : 'https://example.com/new.mp4',
        };
      },
      shop: async () => ({ products: [] }),
    });
    await page.onLoad({ id: 'vid-1' });
    await page.onVideoError();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].action, 'getVideo');
    assert.equal(page.data.src, 'https://example.com/new.mp4');
    assert.equal(page.data.error, '');
    await page.onVideoError();
    assert.equal(calls.length, 2);
    assert.equal(page.data.error, '视频无法播放，请确认已上传云存储文件。');
  });

  it('keeps the player shell mounted and paints video with products once', async () => {
    const wxml = fs.readFileSync(path.join(__dirname, 'player.wxml'), 'utf8');
    assert.equal(wxml.includes('wx:elif="{{video}}"'), false);
    assert.equal(wxml.includes('加载中'), false);
    assert.equal(wxml.includes('user-select'), true);
    assert.equal(wxml.includes('item.runs'), true);

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
    assert.equal(page.data.asking, false);
    assert.equal(page.data.messages.length, 0);
    await page.onAskSend();
    const sends = calls.filter((item) => item.action === 'videoDocSend');
    assert.equal(sends.length, 2);
    assert.equal(sends[0].videoId, 'vid-1');
    assert.equal(sends[0].text, '怎么整平');
    assert.equal(sends[0].currentTimeSec, 9);
    assert.equal(sends[0].requestId, sends[1].requestId);
    assert.equal(Object.prototype.hasOwnProperty.call(sends[0], 'openid'), false);
    assert.equal(page.data.messages[0].text, '先整平');
    assert.equal(page.data.messages[0].runs.map((run) => run.text).join(''), '先整平');
    assert.equal(page.data.inputDraft, '');
    assert.equal(page.data.askBusy, false);
  });

  it('retries a timed-out ask with the same request id and keeps an in-progress bubble', async () => {
    const calls = [];
    let attempt = 0;
    const page = loadPage({
      catalog: async () => ({
        video: { title: '设站' },
        videoUrl: 'https://example.com/a.mp4',
      }),
      shop: async () => ({ products: [] }),
      agent: async (data) => {
        calls.push(data);
        if (data.action === 'videoDocHistory') return { ok: true, messages: [] };
        attempt += 1;
        if (attempt === 1) {
          const error = new Error('服务响应超时，请再试一次');
          error.code = 'TIME_LIMIT';
          throw error;
        }
        return {
          ok: true,
          status: 'replayed',
          messages: [
            { id: 'u1', role: 'user', text: '怎么整平' },
            { id: 'a1', role: 'assistant', text: '先整平' },
          ],
        };
      },
    });
    await page.onLoad({ id: 'vid-1' });
    page.setData({ inputDraft: '怎么整平' });
    await page.onAskSend();
    const sends = calls.filter((item) => item.action === 'videoDocSend');
    assert.equal(sends.length, 2);
    assert.equal(sends[0].requestId, sends[1].requestId);
    assert.equal(page.data.messages.map((item) => item.text).join('|'), '怎么整平|先整平');
    assert.equal(page.data.askError, '');

    let progress = 0;
    const waiting = loadPage({
      catalog: async () => ({ video: { title: '设站' }, videoUrl: 'https://example.com/a.mp4' }),
      shop: async () => ({ products: [] }),
      agent: async (data) => {
        if (data.action === 'videoDocHistory') return { ok: true, messages: [] };
        progress += 1;
        const error = new Error(progress === 1 ? '服务响应超时，请再试一次' : '正在回答，请稍候');
        error.code = progress === 1 ? 'TIME_LIMIT' : 'IN_PROGRESS';
        throw error;
      },
    });
    await waiting.onLoad({ id: 'vid-1' });
    waiting.setData({ inputDraft: '怎么整平' });
    await waiting.onAskSend();
    assert.equal(waiting.data.messages[0].text, '怎么整平');
    assert.equal(waiting.data.askError, '正在回答，请稍候');
    assert.equal(waiting.data.inputDraft, '');

    let timeouts = 0;
    const failed = loadPage({
      catalog: async () => ({ video: { title: '设站' }, videoUrl: 'https://example.com/a.mp4' }),
      shop: async () => ({ products: [] }),
      agent: async (data) => {
        if (data.action === 'videoDocHistory') return { ok: true, messages: [] };
        timeouts += 1;
        const error = new Error('服务响应超时，请再试一次');
        error.code = 'TIME_LIMIT';
        throw error;
      },
    });
    await failed.onLoad({ id: 'vid-1' });
    failed.setData({ inputDraft: '怎么整平' });
    await failed.onAskSend();
    assert.equal(timeouts, 2);
    assert.equal(failed.data.messages.length, 0);
    assert.equal(failed.data.inputDraft, '怎么整平');
  });

  it('shows the question immediately and reveals a long answer in steps', async () => {
    const answer = '一二三四五六七八九十一二三四五六七八九十';
    let releaseSend;
    const page = loadPage({
      catalog: async () => ({
        video: { title: '设站' },
        videoUrl: 'https://example.com/a.mp4',
      }),
      shop: async () => ({ products: [] }),
      agent: (data) => {
        if (data.action === 'videoDocHistory') return Promise.resolve({ ok: true, messages: [] });
        return new Promise((resolve) => {
          releaseSend = () => resolve({
            ok: true,
            messages: [
              { id: 'u1', role: 'user', text: '怎么固定' },
              { id: 'm1', role: 'assistant', text: answer },
            ],
          });
        });
      },
    });
    await page.onLoad({ id: 'vid-1' });
    await page.onTabTap({ currentTarget: { dataset: { tab: 'ask' } } });
    page._revealDelayMs = 0;
    page.setData({ inputDraft: '怎么固定' });
    const pending = page.onAskSend();
    assert.equal(page.data.inputDraft, '');
    assert.equal(page.data.asking, true);
    assert.equal(page.data.askBusy, true);
    assert.equal(page.data.messages[0].role, 'user');
    assert.equal(page.data.messages[0].text, '怎么固定');
    assert.equal(typeof releaseSend, 'function');

    const seen = [];
    const original = page.setData.bind(page);
    page.setData = (next) => {
      seen.push(next);
      original(next);
    };
    releaseSend();
    await pending;
    const partial = seen.some((item) => {
      const last = item.messages && item.messages[item.messages.length - 1];
      return last && last.streaming === true && last.text.length < answer.length;
    });
    assert.equal(partial, true);
    assert.equal(page.data.asking, false);
    assert.equal(page.data.messages[0].text, '怎么固定');
    assert.equal(page.data.messages[1].text, answer);
    assert.equal(page.data.messages[1].streaming, false);
  });
});
