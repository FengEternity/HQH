'use strict';

const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sharePath = require.resolve('./defaultShare');

function loadShare() {
  delete require.cache[sharePath];
  return require(sharePath);
}

afterEach(() => {
  delete require.cache[sharePath];
});

describe('default page share', () => {
  it('adds friend and timeline handlers and keeps the current route', () => {
    const { applyDefaultShare, DEFAULT_TITLE } = loadShare();
    const page = {
      route: 'pages/player/player',
      options: { id: 'v1' },
      data: { video: { posterUrl: 'cloud://bucket/poster.jpg' } },
    };
    const config = applyDefaultShare({});
    const message = config.onShareAppMessage.call(page);
    const timeline = config.onShareTimeline.call(page);

    assert.equal(message.title, DEFAULT_TITLE);
    assert.equal(message.path, '/pages/player/player?id=v1');
    assert.equal(timeline.title, DEFAULT_TITLE);
    assert.equal(timeline.query, 'id=v1');
    assert.equal(message.imageUrl, undefined);
  });

  it('uses the visible title and an https poster when the page has them', () => {
    const { applyDefaultShare } = loadShare();
    const page = {
      route: 'pages/player/player',
      options: { id: 'v1', name: '光谱仪' },
      data: {
        video: {
          title: '光谱仪入门',
          posterUrl: 'https://cdn.example/poster.jpg',
        },
      },
    };
    const config = applyDefaultShare({});
    const message = config.onShareAppMessage.call(page);

    assert.equal(message.title, '光谱仪入门');
    assert.equal(message.path, '/pages/player/player?id=v1&name=%E5%85%89%E8%B0%B1%E4%BB%AA');
    assert.equal(message.imageUrl, 'https://cdn.example/poster.jpg');
    assert.equal(config.onShareTimeline.call(page).query, 'id=v1&name=%E5%85%89%E8%B0%B1%E4%BB%AA');
  });

  it('prefers a product or brand name before the app title', () => {
    const { applyDefaultShare } = loadShare();
    const config = applyDefaultShare({});

    assert.equal(
      config.onShareAppMessage.call({
        route: 'pages/shop-detail/shop-detail',
        options: { id: 'p1' },
        data: { product: { name: '样品瓶' } },
      }).title,
      '样品瓶',
    );
    assert.equal(
      config.onShareAppMessage.call({
        route: 'pages/brand/brand',
        options: {},
        data: { name: '优度' },
      }).title,
      '优度',
    );
  });

  it('keeps a page-defined share handler and still opens the share menu', () => {
    const calls = [];
    const custom = () => ({ title: '自定义', path: '/pages/about/about' });
    let shown = null;
    global.wx = {
      showShareMenu(options) {
        shown = options;
      },
    };
    const { applyDefaultShare } = loadShare();
    const config = applyDefaultShare({
      onShareAppMessage: custom,
      onShow(flag) {
        calls.push(flag);
      },
    });

    assert.equal(config.onShareAppMessage, custom);
    config.onShow('shown');
    assert.deepEqual(calls, ['shown']);
    assert.deepEqual(shown, { menus: ['shareAppMessage', 'shareTimeline'] });
    delete global.wx;
  });

  it('falls back to the home page when the current route is missing', () => {
    const { applyDefaultShare } = loadShare();
    const config = applyDefaultShare({});
    assert.equal(config.onShareAppMessage.call({ data: {}, options: {} }).path, '/pages/index/index');
  });

  it('app.js installs the wrapper before the app registers', () => {
    const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
    const wrapAt = source.indexOf('applyDefaultShare');
    const appAt = source.indexOf('App(');
    assert.ok(wrapAt >= 0);
    assert.ok(appAt > wrapAt);
  });
});
