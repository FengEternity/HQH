'use strict';

const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../../../utils/api');
const pagePath = require.resolve('./ticket');
const originalPage = global.Page;
const originalWx = global.wx;

function loadPage({ ticketingAdmin }) {
  delete require.cache[pagePath];
  const api = require(apiPath);
  const originalTicketingAdmin = api.ticketingAdmin;
  api.ticketingAdmin = ticketingAdmin;

  let definition;
  global.Page = (value) => {
    definition = value;
  };
  global.wx = {
    showToast() {},
    showModal() {},
    redirectTo() {},
  };
  require(pagePath);
  api.ticketingAdmin = originalTicketingAdmin;

  return Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(next) {
      this.data = Object.assign({}, this.data, next);
    },
  });
}

function threadResult(messages, status) {
  return {
    ok: true,
    thread: {
      _id: 'thread-1',
      status: status || 'waiting_human',
      openid: 'openid-abcdefgh',
    },
    messages,
  };
}

afterEach(() => {
  delete require.cache[pagePath];
  global.Page = originalPage;
  global.wx = originalWx;
});

describe('admin ticket chat', () => {
  it('loads messages as chat bubbles and scrolls to the latest one', async () => {
    const page = loadPage({
      ticketingAdmin: async () =>
        threadResult([
          { _id: 'a1', role: 'user', text: '你好', createdAt: 1 },
          { _id: 'a2', role: 'assistant', text: '已转交人工', createdAt: 2 },
          { _id: 'a3', role: 'system', text: '工单已升级', createdAt: 3 },
          { _id: 'a4', role: 'operator', text: '在的', createdAt: 4 },
        ]),
    });
    page.onLoad({ id: 'thread-1' });
    await page.onShow();

    assert.equal(page.data.messages[0].side, 'in');
    assert.equal(page.data.messages[1].side, 'notice');
    assert.equal(page.data.messages[2].side, 'notice');
    assert.equal(page.data.messages[3].side, 'out');
    assert.equal(page.data.anchor, 'ma4');
    assert.equal(page.data.loading, false);
  });

  it('sends a reply into the thread and scrolls to that bubble', async () => {
    const calls = [];
    const page = loadPage({
      ticketingAdmin: async (data) => {
        calls.push(data);
        if (data.action === 'csAdminReply') {
          return threadResult(
            [
              { _id: 'a1', role: 'user', text: '你好', createdAt: 1 },
              { _id: 'a2', role: 'operator', text: data.text, createdAt: 2 },
            ],
            'human',
          );
        }
        return threadResult([{ _id: 'a1', role: 'user', text: '你好', createdAt: 1 }]);
      },
    });
    page.onLoad({ id: 'thread-1' });
    await page.onShow();
    page.onDraft({ detail: { value: '  马上看  ' } });
    await page.reply();

    const reply = calls.find((item) => item.action === 'csAdminReply');
    assert.equal(reply.text, '马上看');
    assert.equal(reply.threadId, 'thread-1');
    assert.equal(page.data.draft, '');
    assert.equal(page.data.messages[1].side, 'out');
    assert.equal(page.data.anchor, 'ma2');
    assert.equal(page.data.submitting, false);
  });
});
