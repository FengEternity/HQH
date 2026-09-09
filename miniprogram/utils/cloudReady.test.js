'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { whenCloudReady } = require('./cloudReady');

describe('whenCloudReady', () => {
  it('resolves immediately when app has no ready promise', async () => {
    await whenCloudReady(null);
    await whenCloudReady({ globalData: {} });
  });

  it('waits for cloudReady before continuing', async () => {
    let done = false;
    const cloudReady = new Promise((resolve) => {
      setTimeout(() => {
        done = true;
        resolve();
      }, 20);
    });
    await whenCloudReady({ globalData: { cloudReady } });
    assert.equal(done, true);
  });

  it('swallows cloudReady rejection so homepage can still load', async () => {
    const cloudReady = Promise.reject(new Error('init failed'));
    // avoid unhandled rejection noise
    cloudReady.catch(() => {});
    await whenCloudReady({ globalData: { cloudReady } });
  });
});
