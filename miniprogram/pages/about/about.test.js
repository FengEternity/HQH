'use strict';

const fs = require('fs');
const path = require('path');
const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../../utils/api');
const pagePath = require.resolve('./about');
const originalPage = global.Page;
const originalWx = global.wx;

function loadPage(adminMe) {
  delete require.cache[pagePath];
  const api = require(apiPath);
  const originalAdminMe = api.adminMe;
  api.adminMe = adminMe;
  let definition;
  global.Page = (value) => {
    definition = value;
  };
  require(pagePath);
  api.adminMe = originalAdminMe;
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

describe('about page', () => {
  it('keeps the changelog on the staff path and marks each note', () => {
    const wxml = fs.readFileSync(path.join(__dirname, 'about.wxml'), 'utf8');
    const staffAt = wxml.indexOf('wx:if="{{staff}}"');
    const titleAt = wxml.indexOf('更新说明');
    assert.ok(staffAt >= 0);
    assert.ok(titleAt > staffAt);
    const section = wxml.slice(titleAt);
    assert.equal(section.includes('class="note-mark"'), true);
    assert.equal((section.match(/·/g) || []).length, 2);
  });

  it('builds the staff view without an identity check', () => {
    global.wx = {
      getAccountInfoSync() {
        return { miniProgram: { envVersion: 'develop', version: '1.0.0' } };
      },
    };
    const page = loadPage(async () => {
      throw new Error('must not check identity');
    });

    page.onLoad({ staff: '1' });

    assert.equal(page.data.staff, true);
    assert.equal(page.data.version, '0.2.6');
  });
});
