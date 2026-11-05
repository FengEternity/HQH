'use strict';

const fs = require('fs');
const path = require('path');
const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../../../utils/api');
const pagePath = require.resolve('./join');
const originalPage = global.Page;
const originalWx = global.wx;

function loadPage(admin) {
  delete require.cache[pagePath];
  const api = require(apiPath);
  const original = api.admin;
  api.admin = admin;

  let definition;
  global.Page = (value) => {
    definition = value;
  };
  require(pagePath);
  api.admin = original;

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

describe('admin invite join page', () => {
  it('claims the query invite exactly once and redirects home', async () => {
    const calls = [];
    const redirects = [];
    global.wx = {
      redirectTo({ url }) {
        redirects.push(url);
      },
    };
    const page = loadPage(async (data) => {
      calls.push(data);
      return { ok: true, role: 'operator' };
    });

    const pending = page.onLoad({ invite: 'invite-code' });
    page.onLoad({ invite: 'another-code' });
    await pending;

    assert.deepEqual(calls, [{ action: 'adminClaimInvite', code: 'invite-code' }]);
    assert.deepEqual(redirects, ['/pages/admin/home/home']);
    assert.equal(page.data.loading, false);
    assert.equal(page.data.result, '领取成功');
  });

  it('shows exact domain errors as a clear result state', async () => {
    const cases = [
      ['INVALID_INVITE', '邀请无效'],
      ['ALREADY_STAFF', '你已在名单中'],
      ['STAFF_DISABLED', '需要管理员重新启用'],
    ];

    for (const [code, message] of cases) {
      global.wx = { redirectTo() {} };
      const page = loadPage(async () => {
        const error = new Error('server text');
        error.code = code;
        throw error;
      });

      await page.onLoad({ invite: 'invite-code' });

      assert.equal(page.data.loading, false, code);
      assert.equal(page.data.result, message, code);
    }
  });

  it('has loading and result states without a manual invite input', () => {
    const wxml = fs.readFileSync(path.join(__dirname, 'join.wxml'), 'utf8');
    assert.equal(wxml.includes('loading'), true);
    assert.equal(wxml.includes('result'), true);
    assert.equal(/<input|<textarea/.test(wxml), false);
  });
});
