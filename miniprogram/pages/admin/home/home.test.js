'use strict';

const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../../../utils/api');
const configPath = require.resolve('../../../config.js');
const pagePath = require.resolve('./home');
const originalPage = global.Page;
const originalWx = global.wx;

function loadPage({ ticketingAdmin, admin, templateId = '' }) {
  delete require.cache[pagePath];
  const config = require(configPath);
  config.contact.newTicketTplId = templateId;
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

afterEach(() => {
  delete require.cache[pagePath];
  global.Page = originalPage;
  global.wx = originalWx;
});

describe('admin home notifications', () => {
  it('binds this WeChat when the operator allows new-ticket notices', async () => {
    const events = [];
    global.wx = {
      getAccountInfoSync() {
        return { miniProgram: { envVersion: 'develop' } };
      },
      requestSubscribeMessage({ tmplIds, success }) {
        events.push(['subscribe', tmplIds]);
        success({ 'tpl-new': 'accept' });
      },
      navigateTo({ url }) {
        events.push(['nav', url]);
      },
      redirectTo() {},
      showToast({ title }) {
        events.push(['toast', title]);
      },
    };
    const page = loadPage({
      templateId: '',
      ticketingAdmin: async (data) => {
        events.push(['api', data.action]);
        if (data.action === 'csNotifyConfig') {
          return { ok: true, newTicketTplId: 'tpl-new' };
        }
        if (data.action === 'csAdminList') {
          return { ok: true, threads: [] };
        }
        if (data.action === 'csRegisterNotify') {
          return { ok: true, enabled: true, quota: 1 };
        }
        return { ok: true };
      },
    });

    await page.onShow();
    page.openInbox();
    await page.bindNotify();

    assert.equal(page.data.newTicketTplId, 'tpl-new');
    assert.equal(page.data.notifyLabel, '还可接收 1 条');
    assert.deepEqual(events.filter((item) => item[0] === 'subscribe'), [
      ['subscribe', ['tpl-new']],
    ]);
    assert.deepEqual(events.filter((item) => item[0] === 'nav'), [
      ['nav', '/pages/admin/inbox/inbox'],
    ]);
    assert.equal(
      events.some((item) => item[0] === 'api' && item[1] === 'csRegisterNotify'),
      true,
    );
    assert.equal(
      events.some((item) => item[0] === 'toast' && item[1].indexOf('已开启') === 0),
      true,
    );
  });

  it('shows the four notification states', () => {
    global.Page = () => {};
    delete require.cache[pagePath];
    const { notifyLabelText } = require(pagePath);
    assert.equal(notifyLabelText('', false, 0), '未配置');
    assert.equal(notifyLabelText('tpl', false, 2), '未开启');
    assert.equal(notifyLabelText('tpl', true, 2), '还可接收 2 条');
    assert.equal(notifyLabelText('tpl', true, 0), '额度已用完');
  });

  it('does not register when the operator rejects, is banned, or the request fails', async () => {
    for (const outcome of ['reject', 'ban', 'filter', 'fail']) {
      const events = [];
      global.wx = {
        getAccountInfoSync() {
          return { miniProgram: { envVersion: 'develop' } };
        },
        requestSubscribeMessage({ success, fail }) {
          events.push(['subscribe']);
          if (outcome === 'fail') {
            fail({ errMsg: 'requestSubscribeMessage:fail' });
            return;
          }
          success({ 'tpl-new': outcome });
        },
        navigateTo() {},
        redirectTo() {},
        showToast({ title }) {
          events.push(['toast', title]);
        },
      };
      const page = loadPage({
        ticketingAdmin: async (data) => {
          events.push(['api', data.action]);
          if (data.action === 'csNotifyConfig') {
            return { ok: true, newTicketTplId: 'tpl-new', enabled: false, quota: 0 };
          }
          if (data.action === 'csAdminList') {
            return { ok: true, threads: [] };
          }
          return { ok: true, enabled: true, quota: 1 };
        },
      });

      await page.onShow();
      await page.bindNotify();

      assert.equal(
        events.some((item) => item[0] === 'api' && item[1] === 'csRegisterNotify'),
        false,
      );
      assert.deepEqual(
        events.filter((item) => item[0] === 'toast'),
        [['toast', '未允许，这个微信收不到通知']],
      );
    }
  });

  it('registers one quota after accept and stops without subscribing again', async () => {
    const events = [];
    global.wx = {
      getAccountInfoSync() {
        return { miniProgram: { envVersion: 'develop' } };
      },
      requestSubscribeMessage({ success }) {
        events.push(['subscribe']);
        success({ 'tpl-new': 'accept' });
      },
      navigateTo() {},
      redirectTo() {},
      showToast({ title }) {
        events.push(['toast', title]);
      },
    };
    const page = loadPage({
      ticketingAdmin: async (data) => {
        events.push(['api', data.action]);
        if (data.action === 'csNotifyConfig') {
          return { ok: true, newTicketTplId: 'tpl-new', enabled: true, quota: 1 };
        }
        if (data.action === 'csRegisterNotify') {
          return { ok: true, enabled: true, quota: 2 };
        }
        if (data.action === 'csUnregisterNotify') {
          return { ok: true, enabled: false, quota: 2 };
        }
        return { ok: true, threads: [] };
      },
    });

    await page.onShow();
    assert.equal(page.data.notifyLabel, '还可接收 1 条');
    assert.equal(page.data.notifyEnabled, true);
    await page.bindNotify();
    assert.equal(page.data.notifyLabel, '还可接收 2 条');
    await page.stopNotify();
    assert.equal(page.data.notifyLabel, '未开启');
    assert.equal(page.data.notifyEnabled, false);
    assert.deepEqual(events.filter((item) => item[0] === 'subscribe'), [['subscribe']]);
  });

  it('keeps the current state when stopping fails', async () => {
    global.wx = {
      getAccountInfoSync() {
        return { miniProgram: { envVersion: 'develop' } };
      },
      requestSubscribeMessage() {},
      navigateTo() {},
      redirectTo() {},
      showToast({ title }) {
        this.toast = title;
      },
    };
    const page = loadPage({
      ticketingAdmin: async (data) => {
        if (data.action === 'csNotifyConfig') {
          return { ok: true, newTicketTplId: 'tpl-new', enabled: true, quota: 1 };
        }
        if (data.action === 'csUnregisterNotify') {
          throw new Error('stop failed');
        }
        return { ok: true, threads: [] };
      },
    });

    await page.onShow();
    await page.stopNotify();

    assert.equal(page.data.notifyEnabled, true);
    assert.equal(page.data.notifyLabel, '还可接收 1 条');
    assert.equal(global.wx.toast, '停止失败');
  });

  it('opens the inbox without subscribing when no template id is configured', async () => {
    const events = [];
    global.wx = {
      getAccountInfoSync() {
        return { miniProgram: { envVersion: 'develop' } };
      },
      requestSubscribeMessage() {
        events.push(['subscribe']);
        return Promise.resolve({});
      },
      navigateTo({ url }) {
        events.push(['nav', url]);
      },
      redirectTo() {},
      showToast({ title }) {
        events.push(['toast', title]);
      },
    };
    const page = loadPage({
      ticketingAdmin: async (data) => {
        if (data.action === 'csNotifyConfig') {
          return { ok: true, newTicketTplId: '' };
        }
        if (data.action === 'csAdminList') {
          return { ok: true, threads: [] };
        }
        return { ok: true };
      },
    });

    await page.onShow();
    page.openInbox();
    page.bindNotify();

    assert.deepEqual(events, [
      ['nav', '/pages/admin/inbox/inbox'],
      ['toast', '未配置通知模板'],
    ]);
    assert.equal(page.data.notifyLabel, '未配置');
  });
});
