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
  it('places a compact notice entry above the status filters', () => {
    const wxml = fs.readFileSync(path.join(__dirname, 'inbox.wxml'), 'utf8');
    const noticeAt = wxml.indexOf('接收会话通知');
    const filtersAt = wxml.indexOf('selectStatus');
    assert.equal(noticeAt > -1 && filtersAt > noticeAt, true);
    assert.equal(wxml.includes('openNotify'), true);
    assert.equal(wxml.includes('设置'), true);
    assert.equal(wxml.includes('{{notifyLabel}}'), true);
    assert.equal(wxml.includes('wx:key="id"'), true);
    assert.equal(wxml.includes('filterId === item.id'), true);
    assert.equal(wxml.includes('loadError'), true);
    assert.equal(wxml.includes('还没有会话'), true);
    assert.equal(wxml.includes('bindchange="toggleNotify"'), false);
    assert.equal(wxml.includes('更换手机号'), false);
    assert.equal(wxml.includes('requestSubscribeMessage'), false);
  });

  it('opens the notify page from the compact entry', async () => {
    const urls = [];
    global.wx = {
      navigateTo({ url }) {
        urls.push(url);
      },
      showToast() {},
    };
    const page = loadPage({
      ticketingAdmin: async (data) => {
        if (data.action === 'csNotifyConfig') {
          return { ok: true, bound: true, enabled: true };
        }
        return { ok: true, threads: [] };
      },
    });
    await page.onShow();
    assert.equal(page.data.notifyLabel, '接收中');
    page.openNotify();
    assert.deepEqual(urls, ['/pages/admin/notify/notify']);
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

  it('列表超时不显示成还没有会话', async () => {
    const titles = [];
    const page = loadPage({
      ticketingAdmin: async (data) => {
        if (data.action === 'csNotifyConfig') {
          return { ok: true, bound: true, enabled: true };
        }
        const err = new Error(
          'cloud.callFunction:fail Error: errCode: -504003 | errMsg: Invoking task timed out after 3 seconds',
        );
        err.errCode = -504003;
        throw err;
      },
    });
    global.wx = {
      showToast({ title }) {
        titles.push(title);
      },
      redirectTo() {},
    };

    await page.onShow();

    assert.equal(page.data.threads.length, 0);
    assert.equal(page.data.loadError, '服务响应超时，请再试一次');
    assert.deepEqual(titles, ['服务响应超时，请再试一次']);
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
