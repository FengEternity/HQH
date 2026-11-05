'use strict';

const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('./api');
const originalWx = global.wx;

afterEach(() => {
  delete require.cache[apiPath];
  global.wx = originalWx;
});

describe('ticketing', () => {
  it('calls the ticketing cloud function and returns its result', async () => {
    const calls = [];
    global.wx = {
      cloud: {
        callFunction(input) {
          calls.push(input);
          return Promise.resolve({ result: { ok: true, messages: [] } });
        },
      },
      getStorageSync() {},
      setStorageSync() {},
    };
    const { ticketing } = require('./api');

    const result = await ticketing({ action: 'csHistory' });

    assert.deepEqual(calls, [
      { name: 'ticketing', data: { action: 'csHistory' } },
    ]);
    assert.deepEqual(result, { ok: true, messages: [] });
  });

  it('throws the cloud result message and code when ticketing rejects the request', async () => {
    global.wx = {
      cloud: {
        callFunction() {
          return Promise.resolve({
            result: { ok: false, code: 'INVALID_STATE', message: '状态已变化' },
          });
        },
      },
      getStorageSync() {},
      setStorageSync() {},
    };
    const { ticketing } = require('./api');

    await assert.rejects(
      () => ticketing({ action: 'csSend', text: '问题' }),
      (error) => error.message === '状态已变化' && error.code === 'INVALID_STATE',
    );
  });

  it('maps a timed out cloud call to a short message', async () => {
    global.wx = {
      cloud: {
        callFunction() {
          const err = new Error(
            'cloud.callFunction:fail Error: errCode: -504003 | errMsg: Invoking task timed out after 3 seconds',
          );
          err.errCode = -504003;
          return Promise.reject(err);
        },
      },
      getStorageSync() {},
      setStorageSync() {},
    };
    const { ticketing } = require('./api');

    await assert.rejects(
      () => ticketing({ action: 'csAdminList' }),
      (error) => error.code === 'TIME_LIMIT' && error.message === '服务响应超时，请再试一次',
    );
  });
});

describe('admin identity wrappers', () => {
  it('calls adminMe through raw catalog without reading legacy storage', async () => {
    const calls = [];
    global.wx = {
      cloud: {
        callFunction(input) {
          calls.push(input);
          return Promise.resolve({
            result: { ok: true, initialized: true, enabled: true, role: 'admin' },
          });
        },
      },
      getStorageSync() {
        throw new Error('must not read legacy ticket');
      },
      setStorageSync() {},
    };

    const { adminMe } = require('./api');
    const result = await adminMe();

    assert.deepEqual(calls, [{ name: 'catalog', data: { action: 'adminMe' } }]);
    assert.equal(result.role, 'admin');
  });

  it('passes admin requests unchanged and never reads or sends the legacy ticket', async () => {
    const calls = [];
    global.wx = {
      cloud: {
        callFunction(input) {
          calls.push(input);
          return Promise.resolve({ result: { ok: true } });
        },
      },
      getStorageSync() {
        throw new Error('must not read legacy ticket');
      },
      setStorageSync() {},
    };
    const { admin, shopAdmin, ticketingAdmin } = require('./api');
    const catalogData = { action: 'adminListBrands' };
    const shopData = { action: 'adminListProducts' };
    const ticketingData = { action: 'csAdminList' };

    await Promise.all([
      admin(catalogData),
      shopAdmin(shopData),
      ticketingAdmin(ticketingData),
    ]);

    assert.deepEqual(calls, [
      { name: 'catalog', data: catalogData },
      { name: 'shop', data: shopData },
      { name: 'ticketing', data: ticketingData },
    ]);
    assert.equal(calls.some((call) => Object.hasOwn(call.data, 'ticket')), false);
  });
});
