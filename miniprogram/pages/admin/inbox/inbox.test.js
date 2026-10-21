'use strict';

const fs = require('fs');
const path = require('path');
const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../../../utils/api');
const configPath = require.resolve('../../../config.js');
const pagePath = require.resolve('./inbox');
const { clearCsViewCache } = require('../csViewCache');
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
    setData(next, callback) {
      this.data = Object.assign({}, this.data, next);
      if (typeof callback === 'function') {
        callback();
      }
    },
  });
}

afterEach(() => {
  clearCsViewCache();
  delete require.cache[pagePath];
  global.Page = originalPage;
  global.wx = originalWx;
});

describe('admin inbox notifications', () => {
  it('places the notice above the status filters', () => {
    const wxml = fs.readFileSync(path.join(__dirname, 'inbox.wxml'), 'utf8');
    const noticeAt = wxml.indexOf('接收会话通知');
    const filtersAt = wxml.indexOf('selectStatus');
    assert.equal(noticeAt > -1 && filtersAt > noticeAt, true);
    assert.equal(wxml.includes('wx:key="id"'), true);
    assert.equal(wxml.includes('filterId === item.id'), true);
    assert.equal(wxml.includes('wx:key="value"'), false);
    assert.equal(
      wxml.includes(
        '开启后，用户发来消息会在运营群 @ 这个手机号。手机号要和企业微信通讯录里的一致。停止后不再 @ 你。',
      ),
      true,
    );
    assert.equal(wxml.includes('checked="{{notifyEnabled}}"'), true);
    assert.equal(wxml.includes('bindchange="toggleNotify"'), true);
    assert.equal(wxml.includes('notifyError'), true);
    assert.equal(wxml.includes('class="chip notify-chip"'), true);
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
    assert.equal(page.data.notifyError, '请填写企业微信里的11位手机号');
  });

  it('binds a WeCom mobile and shows 接收中', async () => {
    const events = [];
    global.wx = {
      showToast({ title }) {
        events.push(title);
      },
    };
    const page = loadPage({
      ticketingAdmin: async (data) => {
        events.push(data.action);
        if (data.action === 'csBindWecom') {
          assert.equal(data.mobile, '13800000000');
          return { ok: true, bound: true, enabled: true };
        }
        return { ok: true, bound: false, enabled: false, threads: [] };
      },
    });
    await page.onShow();
    page.setData({ notifyMobile: '13800000000' });
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
    page.setData({ notifyMobile: '13800000000' });
    await page.toggleNotify({ detail: { value: true } });

    assert.equal(page.data.notifyLabel, '未绑定');
    assert.equal(page.data.notifyError, 'bind failed');
    assert.equal(titles.includes('绑定失败'), true);
    assert.equal(titles.includes('已开启'), false);
  });

  it('restores the switch checked value after a failed toggle', async () => {
    const enableTitles = [];
    const cases = [
      {
        name: 'outside WeCom',
        detail: true,
        original: false,
        wx: { showToast() {} },
        ticketingAdmin: async (data) => {
          if (data.action === 'csNotifyConfig') {
            return { ok: true, bound: false, enabled: false };
          }
          return { ok: true, threads: [] };
        },
      },
      {
        name: 'bind failure',
        detail: true,
        original: false,
        mobile: '13800000000',
        wx: { showToast() {} },
        ticketingAdmin: async (data) => {
          if (data.action === 'csNotifyConfig') {
            return { ok: true, bound: false, enabled: false };
          }
          if (data.action === 'csBindWecom') {
            throw new Error('bind failed');
          }
          return { ok: true, threads: [] };
        },
      },
      {
        name: 'stop failure',
        detail: false,
        original: true,
        wx: {
          qy: {
            login() {
              throw new Error('should not login');
            },
          },
          showToast() {},
        },
        ticketingAdmin: async (data) => {
          if (data.action === 'csNotifyConfig') {
            return { ok: true, bound: true, enabled: true };
          }
          if (data.action === 'csSetNotify') {
            throw new Error('stop failed');
          }
          return { ok: true, threads: [] };
        },
      },
      {
        name: 'enable failure',
        detail: true,
        original: false,
        wx: {
          qy: {
            login() {
              throw new Error('should not login');
            },
          },
          showToast({ title }) {
            enableTitles.push(title);
          },
        },
        ticketingAdmin: async (data) => {
          if (data.action === 'csNotifyConfig') {
            return { ok: true, bound: true, enabled: false };
          }
          if (data.action === 'csSetNotify') {
            throw new Error('enable failed');
          }
          return { ok: true, threads: [] };
        },
      },
    ];

    for (const item of cases) {
      const checked = [];
      global.wx = item.wx;
      const page = loadPage({ ticketingAdmin: item.ticketingAdmin });
      const apply = page.setData.bind(page);
      page.setData = (next, callback) => {
        if (Object.prototype.hasOwnProperty.call(next, 'notifyEnabled')) {
          checked.push(next.notifyEnabled);
        }
        apply(next, callback);
      };
      await page.onShow();
      checked.length = 0;
      if (item.mobile) {
        page.data.notifyMobile = item.mobile;
      }
      await page.toggleNotify({ detail: { value: item.detail } });
      assert.deepEqual(checked, [!item.original, item.original], item.name);
      assert.equal(page.data.notifyEnabled, item.original, item.name);
    }
    assert.deepEqual(enableTitles, []);
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

  it('再次进入时先显示上次的会话，不切到加载中', async () => {
    let listCalls = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const ticketingAdmin = async (data) => {
      if (data.action === 'csNotifyConfig') {
        return { ok: true, bound: false, enabled: false };
      }
      listCalls += 1;
      if (listCalls > 1) {
        await gate;
      }
      return {
        ok: true,
        threads: [{ _id: 'a', updatedAt: 1, nickname: '甲', unread: true }],
      };
    };
    const first = loadPage({ ticketingAdmin });
    await first.onShow();
    const second = loadPage({ ticketingAdmin });
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
    assert.equal(second.data.threads[0].userLabel, '甲');
    release();
    await pending;
  });
});
