'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildUpsertShopProductRequest } = require('./shopEditSave');

describe('buildUpsertShopProductRequest', () => {
  it('blocks save when not hydrated even if url id present', () => {
    const result = buildUpsertShopProductRequest({
      hydrated: false,
      linksReady: false,
      id: 'sku-from-url',
      fields: {
        name: '',
        priceFen: 0,
        coverFileId: '',
        detail: '',
        specName: '',
        specValue: '',
        category: '',
        status: 'unpublished',
      },
      selectedVideoIds: [],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NOT_HYDRATED');
    assert.equal(result.data, undefined);
  });

  it('omits videoIds when checklist not ready', () => {
    const result = buildUpsertShopProductRequest({
      hydrated: true,
      linksReady: false,
      id: 'sku-1',
      fields: {
        name: '主机',
        priceFen: 100,
        coverFileId: 'cloud://c',
        detail: '',
        specName: '',
        specValue: '',
        category: '',
        status: 'unpublished',
      },
      selectedVideoIds: [],
    });
    assert.equal(result.ok, true);
    assert.equal(result.data.id, 'sku-1');
    assert.equal(Object.prototype.hasOwnProperty.call(result.data, 'videoIds'), false);
  });

  it('includes empty videoIds after hydrated checklist (clear all links)', () => {
    const result = buildUpsertShopProductRequest({
      hydrated: true,
      linksReady: true,
      id: 'sku-1',
      fields: {
        name: '主机',
        priceFen: 100,
        coverFileId: 'cloud://c',
        detail: '',
        specName: '',
        specValue: '',
        category: '',
        status: 'unpublished',
      },
      selectedVideoIds: [],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.data.videoIds, []);
  });

  it('new product with ready checklist may send selected video ids', () => {
    const result = buildUpsertShopProductRequest({
      hydrated: true,
      linksReady: true,
      id: '',
      fields: {
        name: '新商品',
        priceFen: 1990,
        coverFileId: 'cloud://c',
        detail: 'd',
        specName: '',
        specValue: '',
        category: '',
        status: 'unpublished',
      },
      selectedVideoIds: ['v1', 'v2'],
    });
    assert.equal(result.ok, true);
    assert.equal(result.data.id, undefined);
    assert.deepEqual(result.data.videoIds, ['v1', 'v2']);
  });
});
