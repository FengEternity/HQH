'use strict';

const { afterEach, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../../utils/api');
const pagePath = require.resolve('./index');
const originalPage = global.Page;
const originalWx = global.wx;
const originalError = console.error;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function loadPage(catalog) {
  delete require.cache[pagePath];
  const api = require(apiPath);
  const originalCatalog = api.catalog;
  api.catalog = catalog;

  let definition;
  global.Page = (value) => {
    definition = value;
  };
  require(pagePath);
  api.catalog = originalCatalog;

  return Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(next) {
      this.data = Object.assign({}, this.data, next);
    },
  });
}

beforeEach(() => {
  console.error = () => {};
});

afterEach(() => {
  delete require.cache[pagePath];
  global.Page = originalPage;
  global.wx = originalWx;
  console.error = originalError;
});

describe('home catalog failures', () => {
  it('retries a transient listHome failure and shows the catalog', async () => {
    const actions = [];
    const page = loadPage(async (data) => {
      actions.push(data.action);
      if (actions.length === 1) {
        throw fail('FAIL', 'catalog 调用失败');
      }
      return {
        ok: true,
        brands: [{ _id: 'brand-1', name: '优度' }],
        videos: [
          {
            _id: 'video-1',
            brandId: 'brand-1',
            title: '开机',
            posterUrl: '',
          },
        ],
      };
    });

    await page.load({ showLoading: true });

    assert.deepEqual(actions, ['listHome', 'listHome']);
    assert.equal(page.data.error, '');
    assert.equal(page.data.loading, false);
    assert.equal(page.data.shelves.length, 1);
  });

  it('shows a visitor message without retrying a missing cloud function', async () => {
    const logged = [];
    console.error = (...args) => logged.push(args);
    let calls = 0;
    const page = loadPage(async () => {
      calls += 1;
      throw fail('FUNCTION_NOT_FOUND', 'catalog 云函数未部署');
    });

    await page.load({ showLoading: true });

    assert.equal(calls, 1);
    assert.equal(page.data.error, '目录暂时打不开，请再试一次');
    assert.equal(page.data.loading, false);
    assert.equal(logged[0][0], 'listHome failed');
    assert.equal(logged[0][1].message, 'catalog 云函数未部署');
  });

  it('keeps an already loaded catalog when a silent refresh fails', async () => {
    const toasts = [];
    global.wx = {
      showToast({ title, icon }) {
        toasts.push({ title, icon });
      },
    };
    let calls = 0;
    const page = loadPage(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          brands: [{ _id: 'brand-1', name: '优度' }],
          videos: [{ _id: 'video-1', brandId: 'brand-1', title: '开机' }],
        };
      }
      throw fail('FAIL', 'catalog 调用失败');
    });

    await page.load({ showLoading: true });
    await page.load({ showLoading: false });

    assert.equal(calls, 3);
    assert.equal(page.data.error, '');
    assert.equal(page.data.shelves.length, 1);
    assert.deepEqual(toasts, [
      { title: '目录暂时打不开，请再试一次', icon: 'none' },
    ]);
  });

  it('loads again when the visitor taps retry', async () => {
    let calls = 0;
    const page = loadPage(async () => {
      calls += 1;
      if (calls === 1) {
        throw fail('FUNCTION_NOT_FOUND', 'catalog 云函数未部署');
      }
      return {
        ok: true,
        brands: [{ _id: 'brand-1', name: '优度' }],
        videos: [{ _id: 'video-1', brandId: 'brand-1', title: '开机' }],
      };
    });

    await page.load({ showLoading: true });
    await page.onRetry();

    assert.equal(calls, 2);
    assert.equal(page.data.error, '');
    assert.equal(page.data.shelves.length, 1);
  });

  it('keeps the catalog failure panel when search fails before any catalog loaded', async () => {
    global.wx = { showToast() {} };
    const page = loadPage(async (data) => {
      if (data.action === 'listHome') {
        throw fail('FUNCTION_NOT_FOUND', 'catalog 云函数未部署');
      }
      throw fail('FAIL', 'catalog 调用失败');
    });

    await page.load({ showLoading: true });
    page.setData({ query: '怎么算参数' });
    await page.onSearch();

    assert.equal(page.data.error, '目录暂时打不开，请再试一次');
    assert.equal(page.data.searched, false);
  });

  it('retries search once and toasts a visitor message', async () => {
    const toasts = [];
    global.wx = {
      showToast({ title, icon }) {
        toasts.push({ title, icon });
      },
    };
    const actions = [];
    const page = loadPage(async (data) => {
      actions.push(data.action);
      throw fail('FAIL', 'catalog 调用失败');
    });
    page.setData({ query: '怎么算参数' });

    await page.onSearch();

    assert.deepEqual(actions, ['search', 'search']);
    assert.equal(page.data.loading, false);
    assert.equal(page.data.searched, false);
    assert.deepEqual(toasts, [
      { title: '搜索暂时不可用，请再试一次', icon: 'none' },
    ]);
  });
});

describe('admin entry gesture', () => {
  it('opens admin login on the eighth title tap', () => {
    const urls = [];
    const page = loadPage(async () => ({ ok: true, brands: [], videos: [] }));
    global.wx = {
      navigateTo({ url }) {
        urls.push(url);
      },
    };
    for (let i = 0; i < 7; i += 1) page.onTitleTap();
    assert.deepEqual(urls, []);
    page.onTitleTap();
    assert.deepEqual(urls, ['/pages/admin/login/login']);
    assert.equal(page.tapCount, 0);
  });
});
