'use strict';

const fs = require('fs');
const path = require('path');
const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../../../utils/api');
const pagePath = require.resolve('./catalog');
const originalPage = global.Page;
const originalWx = global.wx;

function loadPage({ admin }) {
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

describe('admin catalog reprocess entry', () => {
  it('keeps the reprocess row when there are no brands', async () => {
    const wxml = fs.readFileSync(path.join(__dirname, 'catalog.wxml'), 'utf8');
    const emptyAt = wxml.indexOf('还没有品牌');
    const rowAt = wxml.indexOf('重处理不合格视频');
    assert.equal(emptyAt > -1, true);
    assert.equal(rowAt > emptyAt, true);

    const events = [];
    global.wx = {
      navigateTo({ url }) {
        events.push(url);
      },
      redirectTo() {},
      showToast() {},
    };
    const page = loadPage({
      admin: async (data) => {
        if (data.action === 'getIngestProgress') {
          return { ok: true, running: 0, queued: 0, failed: 2 };
        }
        return { ok: true, brands: [] };
      },
    });

    await page.onLoad();
    await page.onShow();
    page.openIngest();

    assert.equal(page.data.brands.length, 0);
    assert.equal(page.data.ingestLabel, '2 条失败');
    assert.deepEqual(events, ['/pages/admin/ingest/ingest']);
  });

  it('shows 进入 when progress cannot be read', async () => {
    global.wx = {
      navigateTo() {},
      redirectTo() {},
      showToast() {},
    };
    let failed = false;
    const page = loadPage({
      admin: async (data) => {
        if (data.action === 'getIngestProgress') {
          if (failed) {
            throw new Error('progress failed');
          }
          return { ok: true, running: 0, queued: 0, failed: 3 };
        }
        return { ok: true, brands: [] };
      },
    });

    await page.onShow();
    assert.equal(page.data.ingestLabel, '3 条失败');
    failed = true;
    await page.onShow();
    assert.equal(page.data.ingestLabel, '进入');
  });
});
