'use strict';

const fs = require('fs');
const path = require('path');
const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const pagePath = require.resolve('./mine');
const originalPage = global.Page;
const originalWx = global.wx;

function loadPage({ ticketing, adminMe } = {}) {
  delete require.cache[pagePath];
  const api = require('../../utils/api');
  const originals = { ticketing: api.ticketing, adminMe: api.adminMe };
  api.ticketing = ticketing || (async () => ({ ok: true }));
  api.adminMe = adminMe || (async () => ({ ok: true, enabled: false }));
  let definition;
  global.Page = (value) => {
    definition = value;
  };
  global.wx = {};
  require(pagePath);
  Object.assign(api, originals);
  return Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(next) {
      this.data = Object.assign({}, this.data, next);
    },
    selectComponent() {
      return null;
    },
  });
}

afterEach(() => {
  delete require.cache[pagePath];
  global.Page = originalPage;
  global.wx = originalWx;
});

describe('mine page', () => {
  it('shows the profile and a quiet version, without a changelog entry', () => {
    const wxml = fs.readFileSync(path.join(__dirname, 'mine.wxml'), 'utf8');
    assert.equal(wxml.includes('关于'), false);
    assert.equal(wxml.includes('openAbout'), false);
    assert.equal(wxml.includes('editProfile'), true);
    assert.equal(wxml.includes('version-foot'), true);
    assert.equal(wxml.includes('profile-gate'), true);
    assert.equal(wxml.includes('prompt="{{false}}"'), true);
    assert.equal(wxml.includes('修改头像与昵称'), false);
    assert.equal(wxml.includes('bindtap="editProfile"'), true);
    assert.equal(wxml.includes('运营工作台'), true);
    assert.equal(wxml.includes('wx:if="{{showAdmin}}"'), true);
    assert.equal(wxml.includes('bindtap="openAdmin"'), true);
    assert.equal(wxml.includes('class="hub-item"'), true);
    assert.equal(wxml.indexOf('运营工作台') < wxml.indexOf('version-foot'), true);
    const footer = wxml.slice(wxml.indexOf('version-foot'));
    assert.equal(footer.includes('bindtap'), false);
  });

  it('opens the existing profile form with the current name and avatar', () => {
    const page = loadPage();
    const edited = [];
    page.selectComponent = (selector) => {
      assert.equal(selector, '#profileGate');
      return {
        edit(profile) {
          edited.push(profile);
        },
      };
    };
    page.setData({ nickname: '张三', avatarFileId: 'cloud://a' });
    page.editProfile();
    assert.deepEqual(edited, [{ nickname: '张三', avatarFileId: 'cloud://a' }]);
    assert.equal(page.openAbout, undefined);
  });

  function wxForMine(urls) {
    return {
      navigateTo({ url }) {
        urls.push(url);
      },
    };
  }

  it('hides the ops row for disabled staff and unknown identity', async () => {
    const disabled = loadPage({
      adminMe: async () => ({ ok: true, enabled: false }),
    });
    global.wx = wxForMine([]);
    await disabled.onShow();
    assert.equal(disabled.data.showAdmin, false);

    const unknown = loadPage({
      adminMe: async () => {
        throw new Error('identity unavailable');
      },
    });
    global.wx = wxForMine([]);
    await unknown.onShow();
    assert.equal(unknown.data.showAdmin, false);
  });

  it('keeps the ops row visible while identity reloads', async () => {
    let resolveIdentity;
    const page = loadPage({
      adminMe: () =>
        new Promise((resolve) => {
          resolveIdentity = resolve;
        }),
    });
    page.setData({ showAdmin: true });

    const shown = page.onShow();

    assert.equal(page.data.showAdmin, true);
    resolveIdentity({ ok: true, enabled: true });
    await shown;
    assert.equal(page.data.showAdmin, true);
  });

  it('shows the ops row for enabled staff even when profile loading fails', async () => {
    const urls = [];
    const page = loadPage({
      ticketing: async () => {
        throw new Error('profile unavailable');
      },
      adminMe: async () => ({ ok: true, enabled: true, role: 'operator' }),
    });
    global.wx = wxForMine(urls);
    await page.onShow();
    assert.equal(page.data.showAdmin, true);
    page.openAdmin();
    assert.deepEqual(urls, ['/pages/admin/home/home']);
  });
});
