'use strict';

const fs = require('fs');
const path = require('path');
const { afterEach, it } = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../../../utils/api');
const pagePath = require.resolve('./login');
const originalPage = global.Page;
const originalWx = global.wx;

function loadPage({ catalog, adminMe }) {
  delete require.cache[pagePath];
  const api = require(apiPath);
  const originals = {
    catalog: api.catalog,
    adminMe: api.adminMe,
  };
  api.catalog = catalog;
  api.adminMe = adminMe;

  let definition;
  global.Page = (value) => {
    definition = value;
  };
  require(pagePath);

  Object.assign(api, originals);
  return Object.assign({}, definition, {
    data: Object.assign({}, definition.data),
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

it('shows the PIN only before initialization', async () => {
  const wxml = fs.readFileSync(path.join(__dirname, 'login.wxml'), 'utf8');
  assert.equal(wxml.includes('wx:if="{{showPin}}"'), true);

  const events = [];
  global.wx = {
    redirectTo({ url }) {
      events.push(['redirect', url]);
    },
    switchTab({ url }) {
      events.push(['switchTab', url]);
    },
    showToast() {},
  };
  const page = loadPage({
    catalog: async () => ({ ok: true }),
    adminMe: async () => ({ ok: true, initialized: false, enabled: false }),
  });

  await page.onShow();

  assert.equal(page.data.showPin, true);
  assert.deepEqual(events, []);
});

it('sends enabled staff home and initialized non-staff back to Mine', async () => {
  const events = [];
  global.wx = {
    redirectTo({ url }) {
      events.push(['redirect', url]);
    },
    switchTab({ url }) {
      events.push(['switchTab', url]);
    },
    showToast() {},
  };
  const staffPage = loadPage({
    catalog: async () => ({ ok: true }),
    adminMe: async () => ({ ok: true, initialized: true, enabled: true }),
  });
  await staffPage.onShow();

  const userPage = loadPage({
    catalog: async () => ({ ok: true }),
    adminMe: async () => ({ ok: true, initialized: true, enabled: false }),
  });
  await userPage.onShow();

  assert.deepEqual(events, [
    ['redirect', '/pages/admin/home/home'],
    ['switchTab', '/pages/mine/mine'],
  ]);
  assert.equal(staffPage.data.showPin, false);
  assert.equal(userPage.data.showPin, false);
});

it('bootstraps the first admin without storing a legacy ticket', async () => {
  const calls = [];
  const events = [];
  global.wx = {
    redirectTo({ url }) {
      events.push(['redirect', url]);
    },
    showToast() {},
    setStorageSync() {
      throw new Error('must not store legacy ticket');
    },
  };
  const page = loadPage({
    catalog: async (data) => {
      calls.push(data);
      return { ok: true, role: 'admin' };
    },
    adminMe: async () => ({ ok: true, initialized: false, enabled: false }),
  });
  page.data.pin = ' 1234 ';

  await page.onLogin();

  assert.deepEqual(calls, [{ action: 'adminLogin', pin: '1234' }]);
  assert.deepEqual(events, [['redirect', '/pages/admin/home/home']]);
});
