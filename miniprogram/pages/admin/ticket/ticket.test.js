'use strict';

const fs = require('fs');
const path = require('path');
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

  it('按接手状态在输入框上方显示接手、放开或正在处理', () => {
    const wxml = fs.readFileSync(path.join(__dirname, 'ticket.wxml'), 'utf8');
    const composerAt = wxml.indexOf('class="composer"');
    const noneAt = wxml.indexOf("claimState === 'none'");
    const mineAt = wxml.indexOf("claimState === 'mine'");
    const otherAt = wxml.indexOf("claimState === 'other'");
    assert.equal(noneAt > -1 && noneAt < composerAt, true);
    assert.equal(mineAt > -1 && mineAt < composerAt, true);
    assert.equal(otherAt > -1 && otherAt < composerAt, true);
    assert.equal(wxml.slice(noneAt, mineAt).includes('接手'), true);
    assert.equal(wxml.slice(mineAt, otherAt).includes('放开'), true);
    assert.equal(wxml.slice(otherAt, composerAt).includes('已有同事正在处理'), true);
    assert.equal(wxml.includes('bindtap="claim"'), true);
    assert.equal(wxml.includes('bindtap="release"'), true);
    assert.equal(wxml.includes('replyClaimOpenid'), false);
    assert.equal(wxml.includes('{{thread.openid}}'), false);
  });

  it('open 工单不渲染接手', async () => {
    const page = loadPage({
      ticketingAdmin: async () =>
        threadResult(
          [{ _id: 'a1', role: 'assistant', text: '请领取账号', createdAt: 1 }],
          'open',
          { viewerOpenid: 'wx-a' },
        ),
    });
    page.onLoad({ id: 'thread-1' });
    await page.onShow();
    const wxml = fs.readFileSync(path.join(__dirname, 'ticket.wxml'), 'utf8');
    assert.equal(page.data.thread.status, 'open');
    assert.equal(renderedClaimLabel(wxml, page.data).includes('接手'), false);
  });

  it('10 分钟窗口区分 none、mine 和 other', () => {
    global.Page = () => {};
    delete require.cache[pagePath];
    const { claimState } = require(pagePath);
    const now = 1_700_000_000_000;
    assert.equal(
      claimState({ replyClaimOpenid: 'wx-a', replyClaimAt: now - 600000 }, 'wx-a', now),
      'none',
    );
    assert.equal(
      claimState({ replyClaimOpenid: 'wx-a', replyClaimAt: now - 599999 }, 'wx-a', now),
      'mine',
    );
    assert.equal(
      claimState({ replyClaimOpenid: 'wx-a', replyClaimAt: now - 599999 }, 'wx-b', now),
      'other',
    );
    assert.equal(claimState({ replyClaimOpenid: '', replyClaimAt: now }, 'wx-a', now), 'none');
    assert.equal(claimState(null, 'wx-a', now), 'none');
  });

  it('不发送未接手的回复', async () => {
    const calls = [];
    const titles = [];
    const page = loadPage({
      ticketingAdmin: async (data) => {
        calls.push(data.action);
        return threadResult([], 'waiting_human', { viewerOpenid: 'wx-a' });
      },
    });
    watchToasts(titles);
    page.setData({ threadId: 'thread-1', draft: '收到' });
    await page.onShow();
    await page.reply();
    assert.equal(calls.includes('csAdminReply'), false);
    assert.equal(page.data.claimState, 'none');
    assert.equal(titles.includes('需要先接手'), true);
  });

  it('接手人可以回复并看到放开', async () => {
    const calls = [];
    const page = loadPage({
      ticketingAdmin: async (data) => {
        calls.push(data.action);
        if (data.action === 'csAdminReply') {
          return threadResult([], 'human', {
            replyClaimOpenid: 'wx-a',
            replyClaimAt: Date.now(),
          });
        }
        return threadResult([], 'human', {
          viewerOpenid: 'wx-a',
          replyClaimOpenid: 'wx-a',
          replyClaimAt: Date.now(),
        });
      },
    });
    page.setData({ threadId: 'thread-1', draft: '收到' });
    await page.onShow();
    await page.reply();
    assert.equal(calls.includes('csAdminReply'), true);
    assert.equal(page.data.claimState, 'mine');
  });

  it('别人接手时不发送并提示正在处理', async () => {
    const calls = [];
    const page = loadPage({
      ticketingAdmin: async (data) => {
        calls.push(data.action);
        return threadResult([], 'waiting_human', {
          viewerOpenid: 'wx-b',
          replyClaimOpenid: 'wx-a',
          replyClaimAt: Date.now(),
        });
      },
    });
    watchToasts(calls);
    page.setData({ threadId: 'thread-1', draft: '收到' });
    await page.onShow();
    await page.reply();
    assert.equal(page.data.claimState, 'other');
    assert.equal(calls.includes('csAdminReply'), false);
    assert.equal(calls.includes('已有同事正在处理'), true);
  });

  it('接手成功后刷新工单', async () => {
    const calls = [];
    const page = loadPage({
      ticketingAdmin: async (data) => {
        calls.push(data);
        if (data.action === 'csClaimReply') {
          return { ok: true };
        }
        const claimed = calls.some((item) => item.action === 'csClaimReply');
        return threadResult([], 'waiting_human', {
          viewerOpenid: 'wx-a',
          replyClaimOpenid: claimed ? 'wx-a' : '',
          replyClaimAt: claimed ? Date.now() : 0,
        });
      },
    });
    page.setData({ threadId: 'thread-1' });
    await page.onShow();
    assert.equal(page.data.claimState, 'none');
    await page.claim();
    const claim = calls.find((item) => item.action === 'csClaimReply');
    assert.equal(claim.threadId, 'thread-1');
    assert.equal(calls.filter((item) => item.action === 'csAdminGet').length >= 2, true);
    assert.equal(page.data.claimState, 'mine');
  });

  it('别人已接手时提示正在处理', async () => {
    const titles = [];
    const page = loadPage({
      ticketingAdmin: async (data) => {
        if (data.action === 'csClaimReply') {
          const error = new Error('claimed');
          error.code = 'CLAIMED';
          throw error;
        }
        return threadResult([], 'waiting_human', { viewerOpenid: 'wx-b' });
      },
    });
    page.setData({ threadId: 'thread-1' });
    await page.onShow();
    watchToasts(titles);
    await page.claim();
    assert.equal(titles.includes('已有同事正在处理'), true);
    assert.equal(page.data.submitting, false);
  });

  it('放开成功后刷新工单', async () => {
    const calls = [];
    const page = loadPage({
      ticketingAdmin: async (data) => {
        calls.push(data);
        if (data.action === 'csReleaseReply') {
          return { ok: true };
        }
        const released = calls.some((item) => item.action === 'csReleaseReply');
        return threadResult([], 'human', {
          viewerOpenid: 'wx-a',
          replyClaimOpenid: released ? '' : 'wx-a',
          replyClaimAt: released ? 0 : Date.now(),
        });
      },
    });
    page.setData({ threadId: 'thread-1' });
    await page.onShow();
    assert.equal(page.data.claimState, 'mine');
    await page.release();
    const release = calls.find((item) => item.action === 'csReleaseReply');
    assert.equal(release.threadId, 'thread-1');
    assert.equal(calls.filter((item) => item.action === 'csAdminGet').length >= 2, true);
    assert.equal(page.data.claimState, 'none');
  });

  it('放开失败时提示放开失败', async () => {
    const titles = [];
    const page = loadPage({
      ticketingAdmin: async (data) => {
        if (data.action === 'csReleaseReply') {
          throw new Error('boom');
        }
        return threadResult([], 'human', {
          viewerOpenid: 'wx-a',
          replyClaimOpenid: 'wx-a',
          replyClaimAt: Date.now(),
        });
      },
    });
    page.setData({ threadId: 'thread-1' });
    await page.onShow();
    watchToasts(titles);
    await page.release();
    assert.equal(titles.includes('放开失败'), true);
    assert.equal(page.data.submitting, false);
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
});
