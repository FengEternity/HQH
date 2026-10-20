'use strict';

const fs = require('fs');
const path = require('path');
const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../../../utils/api');
const configPath = require.resolve('../../../config.js');
const pagePath = require.resolve('./inbox');
const originalPage = global.Page;
const originalWx = global.wx;

function loadPage({ ticketingAdmin, templateId = '' }) {
  delete require.cache[pagePath];
  const config = require(configPath);
  config.contact.newTicketTplId = templateId;
  const api = require(apiPath);
  const original = api.ticketingAdmin;
  api.ticketingAdmin = ticketingAdmin;

  let definition;
  global.Page = (value) => {
    definition = value;
  };
  require(pagePath);
  api.ticketingAdmin = original;

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

describe('admin inbox notifications', () => {
  it('places the notice above the status filters', () => {
    const wxml = fs.readFileSync(path.join(__dirname, 'inbox.wxml'), 'utf8');
    const noticeAt = wxml.indexOf('接收新工单通知');
    const filtersAt = wxml.indexOf('selectStatus');
    assert.equal(noticeAt > -1, true);
    assert.equal(filtersAt > noticeAt, true);
    assert.equal(
      wxml.includes(
        '开启后，新工单会发到你的企业微信，并在运营群 @ 你。停止后这两处都不再通知你。',
      ),
      true,
    );
    assert.equal(wxml.includes('checked="{{notifyEnabled}}"'), true);
    assert.equal(wxml.includes('bindchange="toggleNotify"'), true);
    assert.equal(wxml.includes('bindNotify'), false);
    assert.equal(wxml.includes('停止接收'), false);
    assert.equal(wxml.includes('requestSubscribeMessage'), false);
    assert.equal(wxml.includes('csRegisterNotify'), false);
  });

  it('shows 未绑定, 未开启, and 接收中', () => {
    global.Page = () => {};
    delete require.cache[pagePath];
    const { notifyLabelText } = require(pagePath);
    assert.equal(notifyLabelText(false, false), '未绑定');
    assert.equal(notifyLabelText(false, true), '未绑定');
    assert.equal(notifyLabelText(true, false), '未开启');
    assert.equal(notifyLabelText(true, true), '接收中');
  });

  it('does not subscribe when this WeChat is outside WeCom', async () => {
    const events = [];
    global.wx = {
      requestSubscribeMessage() {
        events.push('subscribe');
      },
      showToast({ title }) {
        events.push(title);
      },
    };
    const page = loadPage({
      ticketingAdmin: async (data) => {
        events.push(data.action);
        if (data.action === 'csNotifyConfig') {
          return { ok: true, bound: false, enabled: false };
        }
        return { ok: true, threads: [] };
      },
    });
    await page.onShow();
    await page.toggleNotify({ detail: { value: true } });
    assert.equal(events.includes('subscribe'), false);
    assert.equal(events.includes('csBindWecom'), false);
    assert.equal(events.includes('请在企业微信中打开后再开启'), true);
  });

  it('binds inside WeCom and shows 接收中', async () => {
    const events = [];
    global.wx = {
      qy: { login: () => Promise.resolve({ code: 'code-1' }) },
      showToast({ title }) {
        events.push(title);
      },
    };
    const page = loadPage({
      ticketingAdmin: async (data) => {
        events.push(data.action);
        if (data.action === 'csBindWecom') {
          assert.equal(data.code, 'code-1');
          return { ok: true, bound: true, enabled: true };
        }
        return { ok: true, bound: false, enabled: false, threads: [] };
      },
    });
    await page.onShow();
    await page.toggleNotify({ detail: { value: true } });
    assert.equal(page.data.notifyLabel, '接收中');
    assert.equal(events.includes('已开启'), true);
  });

  it('toggles an existing binding without logging in again', async () => {
    const actions = [];
    global.wx = {
      qy: {
        login() {
          throw new Error('should not login');
        },
      },
      showToast() {},
    };
    const page = loadPage({
      ticketingAdmin: async (data) => {
        actions.push(data.action);
        if (data.action === 'csNotifyConfig') return { ok: true, bound: true, enabled: false };
        if (data.action === 'csSetNotify') return { ok: true, bound: true, enabled: data.enabled };
        return { ok: true, threads: [] };
      },
    });
    await page.onShow();
    await page.toggleNotify({ detail: { value: true } });
    await page.toggleNotify({ detail: { value: false } });
    assert.deepEqual(
      actions.filter((item) => item === 'csSetNotify'),
      ['csSetNotify', 'csSetNotify'],
    );
    assert.equal(page.data.notifyLabel, '未开启');
  });

  it('keeps 接收中 when stopping fails', async () => {
    global.wx = {
      qy: {
        login() {
          throw new Error('should not login');
        },
      },
      showToast({ title }) {
        this.toast = title;
      },
    };
    const page = loadPage({
      ticketingAdmin: async (data) => {
        if (data.action === 'csNotifyConfig') {
          return { ok: true, bound: true, enabled: true };
        }
        if (data.action === 'csSetNotify') {
          throw new Error('stop failed');
        }
        return { ok: true, threads: [] };
      },
    });

    await page.onShow();
    await page.toggleNotify({ detail: { value: false } });

    assert.equal(page.data.notifyLabel, '接收中');
    assert.equal(global.wx.toast, '停止失败');
  });

  it('keeps 未绑定 when binding fails', async () => {
    const titles = [];
    global.wx = {
      qy: { login: () => Promise.resolve({ code: 'code-1' }) },
      showToast({ title }) {
        titles.push(title);
      },
    };
    const page = loadPage({
      ticketingAdmin: async (data) => {
        if (data.action === 'csNotifyConfig') {
          return { ok: true, bound: false, enabled: false };
        }
        if (data.action === 'csBindWecom') {
          throw new Error('bind failed');
        }
        return { ok: true, threads: [] };
      },
    });

    await page.onShow();
    await page.toggleNotify({ detail: { value: true } });

    assert.equal(page.data.notifyLabel, '未绑定');
    assert.equal(titles.includes('绑定失败'), true);
    assert.equal(titles.includes('已开启'), false);
  });

  it('keeps the notice label when config loading fails', async () => {
    global.wx = {
      navigateTo() {},
      redirectTo() {},
      showToast() {},
    };
    const page = loadPage({
      ticketingAdmin: async (data) => {
        if (data.action === 'csNotifyConfig') {
          throw new Error('config failed');
        }
        return { ok: true, threads: [] };
      },
    });

    await page.onShow();
    assert.equal(page.data.notifyLabel, '未开启');
    assert.equal(page.data.loading, false);
  });
});
