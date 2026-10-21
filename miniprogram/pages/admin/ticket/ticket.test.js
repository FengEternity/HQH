'use strict';

const fs = require('fs');
const path = require('path');
const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../../../utils/api');
const pagePath = require.resolve('./ticket');
const { clearCsViewCache } = require('../csViewCache');
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

function threadResult(messages, status, claim) {
  const extra = claim || {};
  return {
    ok: true,
    viewerOpenid: extra.viewerOpenid || '',
    thread: Object.assign(
      {
        _id: 'thread-1',
        status: status || 'waiting_human',
        openid: 'openid-abcdefgh',
      },
      extra,
    ),
    messages,
  };
}

function watchToasts(titles) {
  global.wx.showToast = ({ title }) => titles.push(title);
}

function renderedClaimLabel(wxml, data) {
  const status = data.thread && data.thread.status;
  if (!status || status === 'closed') {
    return '';
  }
  const claimAt = wxml.indexOf('>接手</view>');
  const composerAt = wxml.indexOf('class="composer"');
  if (claimAt < 0 || claimAt > composerAt) {
    return '';
  }
  const dockHead = wxml.slice(wxml.lastIndexOf('class="dock"', claimAt), claimAt);
  const claimableOnly = /wx:if="\{\{[^"]*waiting_human[^"]*human[^"]*\}\}"/.test(dockHead);
  if (claimableOnly && status !== 'waiting_human' && status !== 'human') {
    return '';
  }
  if (data.claimState === 'none') {
    return '接手';
  }
  if (data.claimState === 'mine') {
    return '放开';
  }
  if (data.claimState === 'other') {
    return '已有同事正在处理';
  }
  return '';
}

afterEach(() => {
  clearCsViewCache();
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
    assert.equal(page.data.thread.conversationLabel, '已回复');
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
        return threadResult([{ _id: 'a1', role: 'user', text: '你好', createdAt: 1 }], 'waiting_human', {
          viewerOpenid: 'wx-a',
          replyClaimOpenid: 'wx-a',
          replyClaimAt: Date.now(),
        });
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

  it('回复先出现在对话里，不等云函数返回', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const page = loadPage({
      ticketingAdmin: async (data) => {
        if (data.action === 'csAdminReply') {
          await gate;
          return threadResult(
            [
              { _id: 'a1', role: 'user', text: '你好', createdAt: 1 },
              { _id: 'a2', role: 'operator', text: data.text, createdAt: 400, userSeenAt: 0 },
            ],
            'human',
            { userSeenAt: 0, operatorSeenAt: 400 },
          );
        }
        return threadResult([{ _id: 'a1', role: 'user', text: '你好', createdAt: 1 }], 'waiting_human', {
          viewerOpenid: 'wx-a',
          replyClaimOpenid: 'wx-a',
          replyClaimAt: Date.now(),
        });
      },
    });
    page.onLoad({ id: 'thread-1' });
    await page.onShow();
    page.onDraft({ detail: { value: '马上看' } });
    const pending = page.reply();
    assert.equal(page.data.draft, '');
    const local = page.data.messages[page.data.messages.length - 1];
    assert.equal(local.text, '马上看');
    assert.equal(local.side, 'out');
    assert.equal(local.readLabel, '未读');
    release();
    await pending;
    const sent = page.data.messages.find((item) => item._id === 'a2');
    assert.equal(sent.readLabel, '未读');
    assert.equal(page.data.messages.some((item) => item.local), false);
  });

  it('发送失败时留下可重试的气泡', async () => {
    let calls = 0;
    const page = loadPage({
      ticketingAdmin: async (data) => {
        if (data.action === 'csAdminReply') {
          calls += 1;
          if (calls === 1) {
            throw new Error('网络不好');
          }
          return threadResult(
            [
              { _id: 'a1', role: 'user', text: '你好', createdAt: 1 },
              { _id: 'a2', role: 'operator', text: data.text, createdAt: 2 },
            ],
            'human',
          );
        }
        return threadResult([{ _id: 'a1', role: 'user', text: '你好', createdAt: 1 }], 'waiting_human', {
          viewerOpenid: 'wx-a',
          replyClaimOpenid: 'wx-a',
          replyClaimAt: Date.now(),
        });
      },
    });
    page.onLoad({ id: 'thread-1' });
    await page.onShow();
    page.setData({ draft: '马上看' });
    await page.reply();
    const failed = page.data.messages.find((item) => item.local);
    assert.equal(failed.failed, true);
    await page.retryReply({ currentTarget: { dataset: { id: failed._id } } });
    assert.equal(page.data.messages.some((item) => item._id === 'a2'), true);
    assert.equal(page.data.messages.some((item) => item.local), false);
  });

  it('会话按持有状态决定能不能回复', () => {
    const wxml = fs.readFileSync(path.join(__dirname, 'ticket.wxml'), 'utf8');
    assert.equal(wxml.includes('bindtap="close"'), false);
    assert.equal(wxml.includes('holdState === \'mine\''), true);
    assert.equal(wxml.includes('>放开</view>'), true);
    assert.equal(wxml.includes('>持有</view>'), true);
    assert.equal(wxml.includes('bindtap="claim"'), true);
    assert.equal(wxml.includes('同事正在回复'), true);
    global.Page = () => {};
    delete require.cache[pagePath];
    const { conversationLabel, holdState, userLabel } = require(pagePath);
    assert.equal(userLabel({ nickname: '张三', openid: 'abcdefghijklmnop' }), '张三');
    const now = 1_700_000_000_000;
    assert.equal(holdState({ replyClaimOpenid: 'wx-a', replyClaimAt: now - 600000 }, 'wx-b', now), 'free');
    assert.equal(holdState({ replyClaimOpenid: 'wx-a', replyClaimAt: now - 599999 }, 'wx-a', now), 'mine');
    assert.equal(holdState({ replyClaimOpenid: 'wx-a', replyClaimAt: now - 599999 }, 'wx-b', now), 'other');
    assert.equal(conversationLabel('human', [{ role: 'user' }, { role: 'operator' }]), '已回复');
    assert.equal(conversationLabel('human', [{ role: 'operator' }, { role: 'user' }]), '未读');
  });

  it('同事持有时不发送', async () => {
    const calls = [];
    const titles = [];
    const page = loadPage({
      ticketingAdmin: async (data) => {
        calls.push(data.action);
        return threadResult([{ _id: 'a1', role: 'user', text: '你好', createdAt: 1 }], 'human', {
          viewerOpenid: 'wx-b',
          replyClaimOpenid: 'wx-a',
          replyClaimAt: Date.now(),
        });
      },
    });
    global.wx.showToast = ({ title }) => titles.push(title);
    page.setData({ threadId: 'thread-1', draft: '收到' });
    await page.onShow();
    assert.equal(page.data.holdState, 'other');
    await page.reply();
    assert.equal(calls.includes('csAdminReply'), false);
    assert.equal(titles.includes('同事正在回复'), true);
  });

  it('没人持有时要点持有才能回复', async () => {
    const calls = [];
    let held = false;
    const page = loadPage({
      ticketingAdmin: async (data) => {
        calls.push(data.action);
        if (data.action === 'csClaimReply') {
          held = true;
          return { ok: true };
        }
        const claim = held
          ? { viewerOpenid: 'wx-a', replyClaimOpenid: 'wx-a', replyClaimAt: Date.now() }
          : { viewerOpenid: 'wx-a' };
        if (data.action === 'csAdminReply') {
          return threadResult(
            [
              { _id: 'a1', role: 'user', text: '你好', createdAt: 1 },
              { _id: 'a2', role: 'operator', text: data.text, createdAt: 2 },
            ],
            'human',
            claim,
          );
        }
        return threadResult([{ _id: 'a1', role: 'user', text: '你好', createdAt: 1 }], 'waiting_human', claim);
      },
    });
    page.setData({ threadId: 'thread-1', draft: '收到' });
    await page.onShow();
    await page.reply();
    assert.equal(calls.includes('csAdminReply'), false);
    await page.claim();
    page.setData({ draft: '收到' });
    await page.reply();
    assert.equal(calls.includes('csClaimReply'), true);
    assert.equal(calls.includes('csAdminReply'), true);
    assert.equal(page.data.thread.conversationLabel, '已回复');
  });

  it('csAdminGet 返回当前运营 OpenID', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../../../cloudfunctions/ticketing/index.js'),
      'utf8',
    );
    const start = source.indexOf("case 'csAdminGet':");
    const end = source.indexOf("case 'csAdminReply':");
    const block = source.slice(start, end);
    assert.equal(block.includes('viewerOpenid: openid'), true);
  });

  it('再次打开同一会话时先显示上次的消息，不切到加载中', async () => {
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const ticketingAdmin = async () => {
      calls += 1;
      if (calls > 1) {
        await gate;
      }
      return threadResult([{ _id: 'a1', role: 'user', text: '还在', createdAt: 1 }]);
    };
    const first = loadPage({ ticketingAdmin });
    first.onLoad({ id: 'thread-1' });
    await first.onShow();
    const second = loadPage({ ticketingAdmin });
    second.onLoad({ id: 'thread-1' });
    let sawLoading = false;
    const apply = second.setData.bind(second);
    second.setData = (next) => {
      if (next.loading === true) {
        sawLoading = true;
      }
      apply(next);
    };
    const pending = second.onShow();
    assert.equal(sawLoading, false);
    assert.equal(second.data.loading, false);
    assert.equal(second.data.messages[0].text, '还在');
    release();
    await pending;
  });
});
