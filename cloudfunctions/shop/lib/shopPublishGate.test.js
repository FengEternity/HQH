'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { assertShopProductPublishable } = require('./shopPublishGate');

describe('shopPublishGate', () => {
  it('allows unpublished draft without cover', () => {
    assert.doesNotThrow(() =>
      assertShopProductPublishable({
        name: '',
        priceFen: -1,
        coverFileId: '',
        status: 'unpublished',
      }),
    );
  });

  it('rejects published when name is missing', () => {
    assert.throws(
      () =>
        assertShopProductPublishable({
          name: '  ',
          priceFen: 100,
          coverFileId: 'cloud://cover',
          status: 'published',
        }),
      (err) => err.code === 'UNPUBLISHABLE',
    );
  });

  it('rejects published when price is missing', () => {
    assert.throws(
      () =>
        assertShopProductPublishable({
          name: 'RTK 主机',
          priceFen: undefined,
          coverFileId: 'cloud://cover',
          status: 'published',
        }),
      (err) => err.code === 'UNPUBLISHABLE',
    );
  });

  it('rejects published when cover is missing', () => {
    assert.throws(
      () =>
        assertShopProductPublishable({
          name: 'RTK 主机',
          priceFen: 100,
          coverFileId: '',
          status: 'published',
        }),
      (err) => err.code === 'UNPUBLISHABLE',
    );
  });

  it('rejects published when priceFen is -1', () => {
    assert.throws(
      () =>
        assertShopProductPublishable({
          name: 'RTK 主机',
          priceFen: -1,
          coverFileId: 'cloud://cover',
          status: 'published',
        }),
      (err) => err.code === 'UNPUBLISHABLE',
    );
  });

  it('accepts published when priceFen is 0', () => {
    assert.doesNotThrow(() =>
      assertShopProductPublishable({
        name: 'RTK 主机',
        priceFen: 0,
        coverFileId: 'cloud://cover',
        status: 'published',
      }),
    );
  });
});
