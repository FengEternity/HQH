'use strict';

const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../../utils/api');
const configPath = require.resolve('../../config.js');
const pagePath = require.resolve('./contact');

const originalPage = global.Page;
const originalWx = global.wx;

function loadPage({ ticketing, storage = {}, replyTplId = '' }) {
  delete require.cache[pagePath];
  const api = require(apiPath);
  const originalTicketing = api.ticketing;
  api.ticketing = ticketing;

  const config = require(configPath);
  config.contact.replyTplId = replyTplId;

  let definition;
  const subscriptionRequests = [];
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
    requestSubscribeMessage(options) {
      subscriptionRequests.push(options);
      return Promise.resolve({});
    },
    setClipboardData() {},
    showToast() {},
  };

  require(pagePath);
  api.ticketing = originalTicketing;

  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(next) {
      this.data = Object.assign({}, this.data, next);
    },
  });
  return { page, storage, subscriptionRequests };
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
      ticketing: async (data) => {
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

  it('quick chips leave out the escalate entry kept beside the input', () => {
    const { page } = loadPage({
      ticketing: async () => ({ ok: true, thread: null, messages: [] }),
    });

    page.onLoad();

    assert.deepEqual(
      page.data.faqs.map((item) => item.id),
      ['claim', 'missing', 'howto'],
    );
  });

  it('claim creates a persistent account and sends it to the current thread', async () => {
    const calls = [];
    const { page, storage } = loadPage({
      storage: {},
      ticketing: async (data) => {
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
      ticketing: async (data) => {
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
      ticketing: async (data) => {
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

  it('missing and human FAQ request reply subscription before sending', async () => {
    const calls = [];
    const { page, subscriptionRequests } = loadPage({
      replyTplId: 'reply-template',
      ticketing: async (data) => {
        calls.push(data);
        return {
          ok: true,
          thread: { _id: 'thread-1', status: 'waiting_human' },
          messages: [],
        };
      },
    });
    page.data.thread = { _id: 'thread-1', status: 'open' };

    await page.askFaq({ currentTarget: { dataset: { id: 'missing' } } });
    await page.askFaq({ currentTarget: { dataset: { id: 'human' } } });

    assert.equal(subscriptionRequests.length, 2);
    assert.deepEqual(calls, [
      {
        action: 'csSend',
        text: '没有我要的讲解',
        faqId: 'missing',
        threadId: 'thread-1',
      },
      {
        action: 'csSend',
        text: '转人工',
        faqId: 'human',
        threadId: 'thread-1',
      },
    ]);
  });

  it('shows the outgoing bubble before the server replies', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { page } = loadPage({
      ticketing: (data) =>
        gate.then(() => ({
          ok: true,
          thread: { _id: 'thread-1', status: 'waiting_human' },
          messages: [{ _id: 'server-1', role: 'user', text: data.text }],
        })),
    });
    page.data.thread = { _id: 'thread-1', status: 'open' };
    page.data.messages = [{ _id: 'welcome', role: 'assistant', text: '欢迎' }];
    page.data.draft = '测试';

    const pending = page.send();

    assert.equal(page.data.draft, '');
    assert.equal(page.data.messages[1].text, '测试');
    assert.equal(page.data.messages[1].role, 'user');
    assert.equal(page.data.messages[1].local, true);
    assert.equal(page.data.messages[1].failed, false);
    assert.equal(page.data.anchor, 'm' + page.data.messages[1]._id);

    release();
    await pending;

    assert.equal(page.data.messages.length, 1);
    assert.equal(page.data.messages[0]._id, 'server-1');
    assert.equal(page.data.messages[0].failed, undefined);
  });

  it('keeps a failed send in the thread with a retry mark', async () => {
    const calls = [];
    const { page } = loadPage({
      ticketing: async (data) => {
        calls.push(data);
        if (calls.length === 1) {
          throw new Error('网络不好');
        }
        return {
          ok: true,
          thread: { _id: 'thread-1', status: 'waiting_human' },
          messages: [{ _id: 'server-1', role: 'user', text: data.text }],
        };
      },
    });
    page.data.thread = { _id: 'thread-1', status: 'open' };
    page.data.messages = [{ _id: 'welcome', role: 'assistant', text: '欢迎' }];
    page.data.draft = '测试';

    await page.send();

    const failed = page.data.messages[1];
    assert.equal(failed.text, '测试');
    assert.equal(failed.failed, true);
    assert.equal(page.data.messages[0]._id, 'welcome');

    await page.retrySend({ currentTarget: { dataset: { id: failed._id } } });

    assert.deepEqual(
      calls.map((item) => item.text),
      ['测试', '测试'],
    );
    assert.equal(page.data.messages.length, 1);
    assert.equal(page.data.messages[0]._id, 'server-1');
  });

  it('empty replyTplId does not request subscription', async () => {
    const { page, subscriptionRequests } = loadPage({
      ticketing: async () => ({
        ok: true,
        thread: { _id: 'thread-1', status: 'waiting_human' },
        messages: [],
      }),
    });
    page.data.thread = { _id: 'thread-1', status: 'open' };

    await page.askFaq({ currentTarget: { dataset: { id: 'missing' } } });

    assert.equal(subscriptionRequests.length, 0);
  });
});
