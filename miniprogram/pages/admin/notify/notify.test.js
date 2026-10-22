'use strict';

const fs = require('fs');
const path = require('path');
const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../../../utils/api');
const pagePath = require.resolve('./notify');
const originalPage = global.Page;
const originalWx = global.wx;

function loadPage({ ticketingAdmin }) {
  delete require.cache[pagePath];
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
  delete require.cache[pagePath];
  global.Page = originalPage;
  global.wx = originalWx;
});

describe('admin notify page', () => {
  it('keeps the phone, switch, and explanation on their own page', () => {
    const wxml = fs.readFileSync(path.join(__dirname, 'notify.wxml'), 'utf8');
    assert.equal(
      wxml.includes(
        '开启后，用户发来消息会在运营群 @ 你。手机号要和企业微信通讯录里的一致。停止后不再 @ 你。',
      ),
      true,
    );
    assert.equal(
      wxml.includes('群机器人无法确认 @ 是否生效。收不到时，请确认你是用企业微信加入该群。'),
      true,
    );
    assert.equal(wxml.includes('更换手机号'), true);
    assert.equal(wxml.includes('notifyBoundMobile'), true);
    assert.equal(wxml.includes('notifyHint'), true);
    assert.equal(wxml.includes('checked="{{notifyEnabled}}"'), true);
    assert.equal(wxml.includes('bindchange="toggleNotify"'), true);
    assert.equal(wxml.includes('notifyError'), true);
    assert.equal(wxml.includes('selectStatus'), false);
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
        return { ok: true };
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
          return {
            ok: true,
            bound: true,
            enabled: true,
            mobile: '13800000000',
            testSent: true,
            message: '测试消息已发到运营群，请现在去看有没有 @ 到你。没有的话，请确认你是用企业微信加入该群。',
          };
        }
        return { ok: true, bound: false, enabled: false };
      },
    });
    await page.onShow();
    page.setData({ notifyMobile: '13800000000' });
    await page.toggleNotify({ detail: { value: true } });
    assert.equal(page.data.notifyLabel, '接收中');
    assert.equal(page.data.notifyBoundMobile, '13800000000');
    assert.match(page.data.notifyHint, /请现在去看有没有 @ 到你/);
    assert.equal(events.includes('已开启'), true);
  });

  it('keeps the binding and shows a failed test send', async () => {
    const titles = [];
    global.wx = {
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
          return {
            ok: true,
            bound: true,
            enabled: true,
            mobile: '13800000000',
            testSent: false,
            message: '已绑定，但测试消息没发到群：93000',
          };
        }
        return { ok: true };
      },
    });
    await page.onShow();
    page.setData({ notifyMobile: '13800000000' });
    await page.toggleNotify({ detail: { value: true } });
    assert.equal(page.data.notifyLabel, '接收中');
    assert.equal(page.data.notifyEnabled, true);
    assert.equal(page.data.notifyError, '已绑定，但测试消息没发到群：93000');
    assert.equal(titles.includes('测试未发出'), true);
  });

  it('replaces the bound mobile through another bind', async () => {
    const mobiles = [];
    global.wx = { showToast() {} };
    const page = loadPage({
      ticketingAdmin: async (data) => {
        if (data.action === 'csNotifyConfig') {
          return { ok: true, bound: true, enabled: true, mobile: '13800000000' };
        }
        if (data.action === 'csBindWecom') {
          mobiles.push(data.mobile);
          return {
            ok: true,
            bound: true,
            enabled: true,
            mobile: data.mobile,
            testSent: true,
            message: '测试消息已发到运营群，请现在去看有没有 @ 到你。没有的话，请确认你是用企业微信加入该群。',
          };
        }
        return { ok: true };
      },
    });
    await page.onShow();
    page.startChangeMobile();
    assert.equal(page.data.notifyChanging, true);
    page.setData({ notifyMobile: '13900000000' });
    await page.confirmChangeMobile();
    assert.deepEqual(mobiles, ['13900000000']);
    assert.equal(page.data.notifyBoundMobile, '13900000000');
    assert.equal(page.data.notifyChanging, false);
  });

  it('toggles an existing binding without logging in again', async () => {
    const actions = [];
    global.wx = { showToast() {} };
    const page = loadPage({
      ticketingAdmin: async (data) => {
        actions.push(data.action);
        if (data.action === 'csNotifyConfig') return { ok: true, bound: true, enabled: false };
        if (data.action === 'csSetNotify') {
          return {
            ok: true,
            bound: true,
            enabled: data.enabled,
            mobile: '13800000000',
            testSent: data.enabled === true,
            message: data.enabled
              ? '测试消息已发到运营群，请现在去看有没有 @ 到你。没有的话，请确认你是用企业微信加入该群。'
              : '',
          };
        }
        return { ok: true };
      },
    });
    await page.onShow();
    await page.toggleNotify({ detail: { value: true } });
    assert.match(page.data.notifyHint, /请现在去看有没有 @ 到你/);
    await page.toggleNotify({ detail: { value: false } });
    assert.deepEqual(
      actions.filter((item) => item === 'csSetNotify'),
      ['csSetNotify', 'csSetNotify'],
    );
    assert.equal(page.data.notifyLabel, '未开启');
    assert.equal(page.data.notifyHint, '');
  });

  it('keeps 接收中 when stopping fails', async () => {
    global.wx = {
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
        return { ok: true };
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
        return { ok: true };
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
        name: 'missing mobile',
        detail: true,
        original: false,
        wx: { showToast() {} },
        ticketingAdmin: async () => ({ ok: true, bound: false, enabled: false }),
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
          return { ok: true };
        },
      },
      {
        name: 'stop failure',
        detail: false,
        original: true,
        wx: { showToast() {} },
        ticketingAdmin: async (data) => {
          if (data.action === 'csNotifyConfig') {
            return { ok: true, bound: true, enabled: true };
          }
          if (data.action === 'csSetNotify') {
            throw new Error('stop failed');
          }
          return { ok: true };
        },
      },
      {
        name: 'enable failure',
        detail: true,
        original: false,
        wx: {
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
          return { ok: true };
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
});
