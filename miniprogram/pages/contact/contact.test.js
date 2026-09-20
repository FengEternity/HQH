'use strict';

const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../../utils/api');
const configPath = require.resolve('../../config.js');
const pagePath = require.resolve('./contact');

const originalPage = global.Page;
const originalWx = global.wx;

function loadPage({ cs, storage = {}, replyTplId = '' }) {
  delete require.cache[pagePath];
  const api = require(apiPath);
  const originalCs = api.cs;
  api.cs = cs;

  const config = require(configPath);
  config.contact.replyTplId = replyTplId;

  let definition;
  global.Page = (value) => {
    definition = value;
  };
  global.wx = {
    getStorageSync(key) {
      return storage[key] || '';
    },
    setStorageSync(key, value) {
      storage[key] = value;
    },
    requestSubscribeMessage() {
      return Promise.resolve({});
    },
    setClipboardData() {},
    showToast() {},
  };

  require(pagePath);
  api.cs = originalCs;

  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(next) {
      this.data = Object.assign({}, this.data, next);
    },
  });
  return { page, storage };
}

afterEach(() => {
  delete require.cache[pagePath];
  global.Page = originalPage;
  global.wx = originalWx;
});

describe('contact page', () => {
  it('onShow loads the server timeline and maps message metadata', async () => {
    const calls = [];
    const { page } = loadPage({
      cs: async (data) => {
        calls.push(data);
        return {
          ok: true,
          thread: { _id: 'thread-1', status: 'open' },
          messages: [
            {
              _id: 'message-1',
              role: 'assistant',
              text: '欢迎',
              meta: {
                account: 'YD1234567890',
                actions: [{ id: 'copyAccount', label: '复制账号' }],
              },
            },
          ],
        };
      },
    });

    page.onLoad();
    await page.onShow();

    assert.deepEqual(calls, [{ action: 'csHistory' }]);
    assert.equal(page.data.thread._id, 'thread-1');
    assert.equal(page.data.messages[0].account, 'YD1234567890');
    assert.deepEqual(page.data.messages[0].actions, [
      { id: 'copyAccount', label: '复制账号' },
    ]);
    assert.equal(page.data.anchor, 'mmessage-1');
    assert.equal(page.data.hours, '工作日 9:00–18:00');
  });

  it('claim creates a persistent account and sends it to the current thread', async () => {
    const calls = [];
    const { page, storage } = loadPage({
      storage: {},
      cs: async (data) => {
        calls.push(data);
        return {
          ok: true,
          thread: { _id: 'thread-1', status: 'open' },
          messages: [],
        };
      },
    });
    page.data.thread = { _id: 'thread-1', status: 'open' };

    await page.askFaq({ currentTarget: { dataset: { id: 'claim' } } });

    assert.match(storage.hqh_support_account, /^YD\d{10}$/);
    assert.deepEqual(calls, [
      {
        action: 'csSend',
        text: '领取账号',
        faqId: 'claim',
        account: storage.hqh_support_account,
        threadId: 'thread-1',
      },
    ]);
  });

  it('send continues after subscription rejection and refreshes the timeline', async () => {
    const calls = [];
    const { page } = loadPage({
      replyTplId: 'reply-template',
      cs: async (data) => {
        calls.push(data);
        return {
          ok: true,
          thread: { _id: 'thread-1', status: 'waiting_human' },
          messages: [{ _id: 'message-2', role: 'user', text: data.text }],
        };
      },
    });
    page.data.thread = { _id: 'thread-1', status: 'open' };
    page.data.draft = '  型号问题  ';
    let requested;
    global.wx.requestSubscribeMessage = ({ tmplIds }) => {
      requested = tmplIds;
      return Promise.reject(new Error('deny'));
    };

    await page.send();

    assert.deepEqual(requested, ['reply-template']);
    assert.deepEqual(calls, [
      { action: 'csSend', text: '型号问题', threadId: 'thread-1' },
    ]);
    assert.equal(page.data.draft, '');
    assert.equal(page.data.thread.status, 'waiting_human');
  });

  it('escalate requests reply subscription and calls csEscalate', async () => {
    const calls = [];
    const { page } = loadPage({
      replyTplId: 'reply-template',
      cs: async (data) => {
        calls.push(data);
        return {
          ok: true,
          thread: { _id: 'thread-1', status: 'waiting_human' },
          messages: [],
        };
      },
    });
    page.data.thread = { _id: 'thread-1', status: 'open' };
    page.data.draft = '需要人工';

    await page.escalate();

    assert.deepEqual(calls, [
      {
        action: 'csEscalate',
        text: '需要人工',
        threadId: 'thread-1',
      },
    ]);
  });
});
