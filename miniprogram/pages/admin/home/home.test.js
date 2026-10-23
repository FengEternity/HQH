'use strict';

const fs = require('fs');
const path = require('path');
const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../../../utils/api');
const pagePath = require.resolve('./home');
const originalPage = global.Page;
const originalWx = global.wx;

function loadPage({ ticketingAdmin, admin, adminMe }) {
  delete require.cache[pagePath];
  const api = require(apiPath);
  const originals = {
    ticketingAdmin: api.ticketingAdmin,
    admin: api.admin,
    adminMe: api.adminMe,
  };
  api.ticketingAdmin = ticketingAdmin;
  api.admin = admin || (async () => ({ ok: true, running: 0, queued: 0, failed: 0 }));
  api.adminMe =
    adminMe || (async () => ({ ok: true, enabled: true, role: 'operator' }));

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
    switchTab({ url }) {
      events.push(['switchTab', url]);
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
    assert.equal(wxml.includes('人员'), true);
    assert.equal(wxml.includes('管理员与运营'), true);
    assert.equal(wxml.includes('wx:if="{{role === \'admin\'}}"'), true);
    assert.equal(wxml.includes('openAbout'), true);
  });

  it('checks identity before daily jobs and lets only admins open staff', async () => {
    const events = [];
    global.wx = wxStub(events);
    const actions = [];
    const page = loadPage({
      adminMe: async () => {
        actions.push('adminMe');
        return { ok: true, enabled: true, role: 'admin' };
      },
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
    page.openStaff();
    page.openAbout();

    assert.equal(page.data.role, 'admin');
    assert.equal(page.data.aboutHint, '开发版 · 0.2.5');
    assert.equal(page.data.pendingLabel, '1 条未读');
    assert.equal(page.data.ingestLabel, '进入');
    assert.deepEqual(
      events.filter((item) => item[0] === 'nav'),
      [
        ['nav', '/pages/admin/catalog/catalog'],
        ['nav', '/pages/admin/shop/shop'],
        ['nav', '/pages/admin/inbox/inbox'],
        ['nav', '/pages/admin/staff/staff'],
        ['nav', '/pages/about/about?staff=1'],
      ],
    );
    assert.equal(actions[0], 'adminMe');
    assert.deepEqual(actions.filter((action) => action.indexOf('cs') === 0), ['csAdminList']);
    assert.equal(events.some((item) => item[0] === 'subscribe'), false);

    const navigationCount = events.filter((item) => item[0] === 'nav').length;
    page.setData({ role: 'operator' });
    page.openStaff();
    assert.equal(events.filter((item) => item[0] === 'nav').length, navigationCount);
  });

  it('keeps the staff row visible while identity reloads', async () => {
    let resolveIdentity;
    global.wx = wxStub([]);
    const page = loadPage({
      adminMe: () =>
        new Promise((resolve) => {
          resolveIdentity = resolve;
        }),
      ticketingAdmin: async () => ({ ok: true, threads: [] }),
    });
    page.setData({ role: 'admin' });

    const shown = page.onShow();

    assert.equal(page.data.role, 'admin');
    resolveIdentity({ ok: true, enabled: true, role: 'admin' });
    await shown;
    assert.equal(page.data.role, 'admin');
  });

  it('returns non-staff to Mine without loading protected jobs', async () => {
    const events = [];
    const actions = [];
    global.wx = wxStub(events);
    const page = loadPage({
      adminMe: async () => ({ ok: true, enabled: false }),
      ticketingAdmin: async () => {
        actions.push('ticketing');
        return { ok: true, threads: [] };
      },
      admin: async () => {
        actions.push('catalog');
        return { ok: true };
      },
    });

    await page.onShow();

    assert.deepEqual(actions, []);
    assert.deepEqual(events, [['switchTab', '/pages/mine/mine']]);
    assert.equal(page.data.role, '');
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
