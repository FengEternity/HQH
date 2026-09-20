'use strict';

const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('./api');
const originalWx = global.wx;

afterEach(() => {
  delete require.cache[apiPath];
  global.wx = originalWx;
});

describe('cs', () => {
  it('calls the cs cloud function and returns its result', async () => {
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
    const { cs } = require('./api');

    const result = await cs({ action: 'csHistory' });

    assert.deepEqual(calls, [
      { name: 'cs', data: { action: 'csHistory' } },
    ]);
    assert.deepEqual(result, { ok: true, messages: [] });
  });

  it('throws the cloud result message and code when cs rejects the request', async () => {
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
    const { cs } = require('./api');

    await assert.rejects(
      () => cs({ action: 'csSend', text: '问题' }),
      (error) => error.message === '状态已变化' && error.code === 'INVALID_STATE',
    );
  });
});

describe('csAdmin', () => {
  it('adds the stored admin ticket without mutating the request', async () => {
    const calls = [];
    global.wx = {
      cloud: {
        callFunction(input) {
          calls.push(input);
          return Promise.resolve({ result: { ok: true, threads: [] } });
        },
      },
      getStorageSync(key) {
        return key === 'hqh_admin_ticket' ? 'ticket-1' : '';
      },
      setStorageSync() {},
    };
    const { csAdmin } = require('./api');
    const data = { action: 'csAdminList' };

    await csAdmin(data);

    assert.deepEqual(data, { action: 'csAdminList' });
    assert.deepEqual(calls, [
      {
        name: 'cs',
        data: { ticket: 'ticket-1', action: 'csAdminList' },
      },
    ]);
  });
});
