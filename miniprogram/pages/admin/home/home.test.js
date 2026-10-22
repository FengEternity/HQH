'use strict';

const fs = require('fs');
const path = require('path');
const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../../../utils/api');
const pagePath = require.resolve('./home');
const originalPage = global.Page;
const originalWx = global.wx;

function loadPage({ ticketingAdmin, admin }) {
  delete require.cache[pagePath];
  const api = require(apiPath);
  const originals = {
    ticketingAdmin: api.ticketingAdmin,
    admin: api.admin,
  };
  api.ticketingAdmin = ticketingAdmin;
  api.admin = admin || (async () => ({ ok: true, running: 0, queued: 0, failed: 0 }));

  let definition;
  global.Page = (value) => {
    definition = value;
  };
  require(pagePath);
  Object.assign(api, originals);

  return Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(next) {
      this.data = Object.assign({}, this.data, next);
    },
  });
}

function wxStub(events) {
  return {
    getAccountInfoSync() {
      return { miniProgram: { envVersion: 'develop' } };
    },
    navigateTo({ url }) {
      events.push(['nav', url]);
    },
    redirectTo({ url }) {
      events.push(['redirect', url]);
    },
    showToast({ title }) {
      events.push(['toast', title]);
    },
    requestSubscribeMessage() {
      events.push(['subscribe']);
    },
  };
}

afterEach(() => {
  delete require.cache[pagePath];
  global.Page = originalPage;
  global.wx = originalWx;
});

describe('admin home workbench', () => {
  it('lists only the daily jobs and a version footer', () => {
    const wxml = fs.readFileSync(path.join(__dirname, 'home.wxml'), 'utf8');
    assert.equal(wxml.includes('以后增加模块会放在这一页'), false);
    assert.equal(wxml.includes('接收新工单通知'), false);
    assert.equal(wxml.includes('重处理不合格视频'), false);
    assert.equal(wxml.includes('版本与日志'), false);
    assert.equal(wxml.includes('内容运营'), true);
    assert.equal(wxml.includes('商品运营'), true);
    assert.equal(wxml.includes('客服工单'), true);
    assert.equal(wxml.includes('openAbout'), true);
  });

  it('opens each daily job and the staff changelog', async () => {
    const events = [];
    global.wx = wxStub(events);
    const actions = [];
    const page = loadPage({
      ticketingAdmin: async (data) => {
        actions.push(data.action);
        return { ok: true, threads: [{ _id: 'a', unread: true }] };
      },
      admin: async (data) => {
        actions.push(data.action);
        return { ok: true, running: 0, queued: 0, failed: 0 };
      },
    });

    await page.onShow();
    page.openCatalog();
    page.openShop();
    page.openInbox();
    page.openAbout();

    assert.equal(page.data.aboutHint, '开发版 · 0.2.5');
    assert.equal(page.data.pendingLabel, '1 条未读');
    assert.equal(page.data.ingestLabel, '进入');
    assert.deepEqual(
      events.filter((item) => item[0] === 'nav'),
      [
        ['nav', '/pages/admin/catalog/catalog'],
        ['nav', '/pages/admin/shop/shop'],
        ['nav', '/pages/admin/inbox/inbox'],
        ['nav', '/pages/about/about?staff=1'],
      ],
    );
    assert.deepEqual(actions.filter((action) => action.indexOf('cs') === 0), ['csAdminList']);
    assert.equal(events.some((item) => item[0] === 'subscribe'), false);
  });

  it('shows the ingest state on content ops and clears it when the read fails', async () => {
    const events = [];
    global.wx = wxStub(events);
    let progress = { ok: true, running: 1, queued: 4, failed: 2 };
    const page = loadPage({
      ticketingAdmin: async () => ({ ok: true, threads: [] }),
      admin: async () => {
        if (progress instanceof Error) {
          throw progress;
        }
        return progress;
      },
    });

    await page.onShow();
    assert.equal(page.data.ingestLabel, '正在转');
    progress = { ok: true, running: 0, queued: 4, failed: 2 };
    await page.onShow();
    assert.equal(page.data.ingestLabel, '4 条排队');
    progress = { ok: true, running: 0, queued: 0, failed: 2 };
    await page.onShow();
    assert.equal(page.data.ingestLabel, '2 条失败');
    progress = { ok: true, running: 0, queued: 0, failed: 0 };
    await page.onShow();
    assert.equal(page.data.ingestLabel, '进入');

    page.openCatalog();
    assert.deepEqual(events.filter((item) => item[0] === 'nav'), [
      ['nav', '/pages/admin/catalog/catalog'],
    ]);

    progress = new Error('progress failed');
    await page.onShow();
    assert.equal(page.data.ingestLabel, '进入');
  });

  it('keeps the pending-ticket failure text', async () => {
    const events = [];
    global.wx = wxStub(events);
    const page = loadPage({
      ticketingAdmin: async () => {
        const err = new Error('工单加载失败');
        err.code = 'BOOM';
        throw err;
      },
    });

    await page.onShow();
    assert.equal(page.data.pendingLabel, '工单加载失败');
    assert.deepEqual(events.filter((item) => item[0] === 'toast'), [
      ['toast', '工单加载失败'],
    ]);
  });
});
