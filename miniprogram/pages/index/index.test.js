'use strict';

const fs = require('node:fs');
const path = require('node:path');
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

function loadPage(catalog, search, agent) {
  delete require.cache[pagePath];
  const api = require(apiPath);
  const originalCatalog = api.catalog;
  const originalSearch = api.search;
  const originalAgent = api.agent;
  api.catalog = catalog;
  api.search = search || (async () => {
    const err = new Error('search 调用失败');
    err.code = 'FAIL';
    throw err;
  });
  api.agent = agent || (async () => {
    const err = new Error('agent 调用失败');
    err.code = 'FAIL';
    throw err;
  });

  let definition;
  global.Page = (value) => {
    definition = value;
  };
  require(pagePath);
  api.catalog = originalCatalog;
  api.search = originalSearch;
  api.agent = originalAgent;

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
    await page.onSearchConfirm();

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
    const calls = [];
    const page = loadPage(
      async () => ({ ok: true, brands: [], videos: [] }),
      async (data) => {
        calls.push(data);
        throw fail('FAIL', 'search 调用失败');
      },
    );
    page.setData({ query: '怎么算参数', brands: [{ _id: 'b1' }], shelves: [{ id: 'b1' }] });

    await page.onSearchConfirm();

    assert.equal(calls.length, 2);
    assert.equal(calls[0].scene, 'video');
    assert.equal(calls[0].mode, 'keyword');
    assert.equal(calls[0].query, '怎么算参数');
    assert.equal(page.data.searching, false);
    assert.equal(page.data.searched, false);
    assert.equal(page.data.query, '怎么算参数');
    assert.deepEqual(toasts, [
      { title: '搜索暂时不可用，请再试一次', icon: 'none' },
    ]);
  });
});

describe('explainer search', () => {
  it('keeps keyword and ai search in one bar with an ai toggle', () => {
    const wxml = fs.readFileSync(path.join(__dirname, 'index.wxml'), 'utf8');
    assert.match(wxml, /bindtap="onModeTap"/);
    assert.match(wxml, /bindtap="onSearchConfirm"/);
    assert.match(wxml, /bindconfirm="onSearchConfirm"/);
    assert.match(wxml, /aria-label="\{\{queryMode === 'ai' \? '关闭 AI 搜索' : '开启 AI 搜索'\}\}"/);
    assert.match(wxml, /aria-label="搜索"/);
    assert.match(wxml, /class="ai-toggle \{\{queryMode === 'ai' \? 'ai-toggle-on' : ''\}\}/);
    assert.match(wxml, /class="ai-toggle-mark">AI</);
    assert.doesNotMatch(wxml, /search-chevron/);
    assert.match(wxml, /型号、菜单名或操作/);
    assert.match(wxml, /用一句话描述想看的讲解/);
    assert.match(wxml, /可以换个型号或菜单名，也可以把问题发给客服/);
    assert.match(wxml, /bindtap="onSearchMiss"/);
    assert.match(wxml, /bindtap="onClearQuery"/);
    assert.match(wxml, /aria-label="清除"/);
    assert.match(wxml, /wx:if="\{\{query\}\}"/);
    assert.match(wxml, /联系客服/);
    assert.match(wxml, /按名称找到的/);
  });

  it('toggles ai search from the logo', () => {
    const page = loadPage(async () => ({ ok: true, brands: [], videos: [] }));

    page.onModeTap();
    assert.equal(page.data.queryMode, 'ai');

    page.onModeTap();
    assert.equal(page.data.queryMode, 'keyword');
  });

  it('does not toggle ai search while a search is running', () => {
    const page = loadPage(async () => ({ ok: true, brands: [], videos: [] }));
    page.setData({ searching: true, queryMode: 'keyword' });

    page.onModeTap();

    assert.equal(page.data.queryMode, 'keyword');
  });

  it('opens customer service with the missed query', () => {
    const storage = {};
    const tabs = [];
    global.wx = {
      setStorageSync(key, value) {
        storage[key] = value;
      },
      switchTab(options) {
        tabs.push(options.url);
      },
    };
    const page = loadPage(async () => ({ ok: true, brands: [], videos: [] }));
    page.setData({ query: ' 怎么计算 ' });

    page.onSearchMiss();

    assert.equal(storage.hqh_search_miss_draft, '没找到讲解：怎么计算');
    assert.deepEqual(tabs, ['/pages/contact/contact']);
  });

  it('does not call search for a blank query', async () => {
    let calls = 0;
    const page = loadPage(async () => ({ ok: true, brands: [], videos: [] }), async () => {
      calls += 1;
      return { ok: true, scene: 'video', items: [] };
    });
    page.setData({ query: '   ' });

    await page.onSearchConfirm();

    assert.equal(calls, 0);
    assert.equal(page.data.searched, false);
  });

  it('shows the semantic notice and filters the same result by brand', async () => {
    const calls = [];
    const page = loadPage(async () => ({ ok: true, brands: [], videos: [] }), async (data) => {
      calls.push(data);
      return {
        ok: true,
        scene: 'video',
        notice: 'semantic_unavailable',
        items: [
          { id: 'v1', title: '甲', brandId: 'b1', brandName: '中海达', modelName: '', tags: [] },
          { id: 'v2', title: '乙', brandId: 'b2', brandName: '华测', modelName: '', tags: [] },
        ],
      };
    });
    page.setData({ query: '对中' });

    page.setData({ queryMode: 'ai' });
    await page.onSearchConfirm();
    page.onBrandTap({ currentTarget: { dataset: { id: 'b2' } } });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].mode, 'ai');
    assert.equal(page.data.aiLabel, 'AI 搜索结果');
    assert.equal(page.data.noticeText, '按描述来找暂时不可用，以下是按名称找到的');
    assert.deepEqual(page.data.keywordResults.map((item) => item.id), ['v2']);
  });

  it('keeps an empty semantic failure distinct from no results', async () => {
    const page = loadPage(async () => ({ ok: true, brands: [], videos: [] }), async () => ({
      ok: true,
      scene: 'video',
      notice: 'semantic_unavailable',
      items: [],
    }));
    page.setData({ query: '怎么算' });

    page.setData({ queryMode: 'ai' });
    await page.onSearchConfirm();

    assert.equal(page.data.searched, true);
    assert.equal(page.data.results.length, 0);
    assert.equal(page.data.noticeText, '按描述来找暂时不可用');
    assert.equal(page.data.aiLabel, 'AI 搜索结果');
  });

  it('keyword search ignores a semantic notice and keeps the query on the keyword lane', async () => {
    const calls = [];
    const page = loadPage(async () => ({ ok: true, brands: [], videos: [] }), async (data) => {
      calls.push(data);
      return {
        ok: true,
        scene: 'video',
        notice: 'semantic_unavailable',
        items: [{ id: 'v1', title: '甲', brandId: 'b1', brandName: '中海达', modelName: '', tags: [] }],
      };
    });
    page.setData({ query: 'iRTK5' });

    await page.onSearchConfirm();

    assert.deepEqual(calls, [{ scene: 'video', mode: 'keyword', query: 'iRTK5' }]);
    assert.equal(page.data.searchMode, 'keyword');
    assert.equal(page.data.noticeText, '');
    assert.equal(page.data.aiLabel, '');
    assert.deepEqual(page.data.results.map((item) => item.id), ['v1']);
  });

  it('routes ai search to the agent and renders one merged list', async () => {
    const calls = [];
    const page = loadPage(
      async () => ({ ok: true, brands: [], videos: [] }),
      async () => { throw fail('FAIL', 'search 不该被调用'); },
      async (data) => {
        calls.push(data);
        return {
          ok: true,
          scene: 'video',
          items: [{ id: 'cors', title: '南方CORS设置', brandId: 'b1', brandName: '南方', modelName: '', tags: [] }],
        };
      },
    );
    page.setData({ query: '怎么设置账号', queryMode: 'ai' });

    await page.onSearchConfirm();

    const videoCalls = calls.filter((item) => item.action === 'videoSearch');
    const traceCalls = calls.filter((item) => item.action === 'videoSearchTrace');
    assert.equal(videoCalls.length, 1);
    assert.equal(videoCalls[0].query, '怎么设置账号');
    assert.match(videoCalls[0].runId, /^[A-Za-z0-9_-]{8,64}$/);
    assert.equal(traceCalls[0].runId, videoCalls[0].runId);
    assert.equal(page.data.searchMode, 'ai');
    assert.equal(page.data.aiLabel, 'AI 搜索结果');
    assert.equal(page.data.noticeText, '');
    assert.deepEqual(page.data.results.map((item) => item.id), ['cors']);
    assert.deepEqual(page.data.keywordResults, []);
    assert.equal(page.data.agentMerged, true);
    assert.deepEqual(page.data.searchSteps, []);
  });

  it('replaces the waiting line with the agent steps while the search is running', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const page = loadPage(
      async () => ({ ok: true, brands: [], videos: [] }),
      async () => { throw fail('FAIL', 'search 不该被调用'); },
      async (data) => {
        if (data.action === 'videoSearchTrace') {
          return {
            ok: true,
            steps: [
              { key: 'understand', label: '理解这句话', state: 'done', detail: '' },
              { key: 'find:账号设置', label: '查找「账号设置」', state: 'running', detail: '' },
            ],
          };
        }
        await gate;
        return { ok: true, scene: 'video', items: [] };
      },
    );
    page.setData({ query: '怎么设置账号', queryMode: 'ai' });
    const pending = page.onSearchConfirm();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(page.data.searching, true);
    assert.equal(page.data.searchSteps[1].label, '查找「账号设置」');
    assert.equal(page.data.searchSteps[1].state, 'running');

    release();
    await pending;
    assert.equal(page.data.searching, false);
    assert.deepEqual(page.data.searchSteps, []);
  });

  it('falls back to the two lane search when the agent call fails', async () => {
    const agentCalls = [];
    const searchCalls = [];
    const page = loadPage(
      async () => ({ ok: true, brands: [], videos: [] }),
      async (data) => {
        searchCalls.push(data);
        return {
          ok: true,
          scene: 'video',
          items: [{ id: 'kw', title: '参数计算', brandId: 'b1', brandName: '南方', modelName: '', tags: [] }],
          keywordItems: [{ id: 'kw', title: '参数计算', brandId: 'b1', brandName: '南方', modelName: '', tags: [] }],
          semanticOnlyItems: [],
        };
      },
      async (data) => {
        agentCalls.push(data);
        throw fail('FUNCTION_NOT_FOUND', 'agent 云函数未部署');
      },
    );
    page.setData({ query: '怎么计算', queryMode: 'ai' });

    await page.onSearchConfirm();

    const videoCalls = agentCalls.filter((item) => item.action === 'videoSearch');
    assert.equal(videoCalls.length, 1);
    assert.equal(videoCalls[0].query, '怎么计算');
    assert.deepEqual(searchCalls, [{ scene: 'video', mode: 'ai', query: '怎么计算' }]);
    assert.equal(page.data.agentMerged, false);
    assert.deepEqual(page.data.keywordResults.map((item) => item.id), ['kw']);
  });

  it('keeps vector-only hits above the keyword results on the fallback path', async () => {
    const page = loadPage(async () => ({ ok: true, brands: [], videos: [] }), async () => ({
      ok: true,
      scene: 'video',
      items: [
        { id: 'kw', title: '参数计算', brandId: 'b1', brandName: '南方', modelName: '', tags: [] },
        { id: 'ai', title: '坐标换算', brandId: 'b2', brandName: '华测', modelName: '', tags: [] },
      ],
      keywordItems: [{ id: 'kw', title: '参数计算', brandId: 'b1', brandName: '南方', modelName: '', tags: [] }],
      semanticOnlyItems: [{ id: 'ai', title: '坐标换算', brandId: 'b2', brandName: '华测', modelName: '', tags: [] }],
    }));
    page.setData({ query: '怎么计算', queryMode: 'ai' });

    await page.onSearchConfirm();

    assert.deepEqual(page.data.results.map((item) => item.id), ['ai']);
    assert.deepEqual(page.data.keywordResults.map((item) => item.id), ['kw']);
  });

  it('restores the catalog when the query is cleared', () => {
    const page = loadPage(async () => ({ ok: true, brands: [], videos: [] }));
    page.setData({
      query: 'iRTK5',
      searched: true,
      searching: false,
      searchMode: 'ai',
      aiLabel: 'AI 搜索结果',
      results: [{ id: 'v1' }],
      searchItems: [{ id: 'v1' }],
      noticeText: '只搜了一部分',
      brands: [{ _id: 'b1', name: '中海达' }],
      allVideos: [{ _id: 'v9', brandId: 'b1', title: '目录视频', brandName: '中海达' }],
    });

    page.onQuery({ detail: { value: '   ' } });

    assert.equal(page.data.query, '   ');
    assert.equal(page.data.searched, false);
    assert.equal(page.data.searching, false);
    assert.deepEqual(page.data.results, []);
    assert.equal(page.data.aiLabel, '');
    assert.equal(page.data.noticeText, '');
    assert.equal(page.data.shelves.length, 1);
  });

  it('drops an in-flight search when the query is cleared', async () => {
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const page = loadPage(
      async () => ({ ok: true, brands: [], videos: [] }),
      () => pending,
    );
    page.setData({
      query: 'iRTK5',
      brands: [{ _id: 'b1', name: '中海达' }],
      allVideos: [{ _id: 'v9', brandId: 'b1', title: '目录视频', brandName: '中海达' }],
    });

    const pendingSearch = page.onSearchConfirm();
    page.onClearQuery();
    release({
      ok: true,
      scene: 'video',
      items: [{ id: 'v1', title: '晚到', brandId: 'b1', brandName: '中海达', modelName: '', tags: [] }],
    });
    await pendingSearch;

    assert.equal(page.data.query, '');
    assert.equal(page.data.searched, false);
    assert.equal(page.data.searching, false);
    assert.deepEqual(page.data.results, []);
    assert.equal(page.data.shelves.length, 1);
  });

  it('keeps the current results while the query is only edited', () => {
    const page = loadPage(async () => ({ ok: true, brands: [], videos: [] }));
    page.setData({
      query: 'iRTK5',
      searched: true,
      results: [{ id: 'v1' }],
    });

    page.onQuery({ detail: { value: 'iRTK' } });

    assert.equal(page.data.query, 'iRTK');
    assert.equal(page.data.searched, true);
    assert.deepEqual(page.data.results, [{ id: 'v1' }]);
  });

  it('does not call ai search for a blank query', async () => {
    let calls = 0;
    const page = loadPage(async () => ({ ok: true, brands: [], videos: [] }), async () => {
      calls += 1;
      return { ok: true, scene: 'video', items: [] };
    });
    page.setData({ query: '   ', searched: true, aiLabel: 'AI 搜索结果', searchMode: 'ai' });

    page.setData({ queryMode: 'ai' });
    await page.onSearchConfirm();

    assert.equal(calls, 0);
    assert.equal(page.data.searched, false);
    assert.equal(page.data.aiLabel, '');
  });
});

describe('home catalog cache', () => {
  it('skips listHome when the last success is under a minute old', async () => {
    let calls = 0;
    const page = loadPage(async () => {
      calls += 1;
      return { ok: true, brands: [], videos: [] };
    });
    await page.load({ showLoading: true });
    await page.onShow();
    assert.equal(calls, 1);
    page._homeLoadedAt = Date.now() - 61000;
    await page.onShow();
    assert.equal(calls, 2);
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
