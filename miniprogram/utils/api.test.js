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
});

describe('ticketingAdmin', () => {
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
    const { ticketingAdmin } = require('./api');
    const data = { action: 'csAdminList' };

    await ticketingAdmin(data);

    assert.deepEqual(data, { action: 'csAdminList' });
    assert.deepEqual(calls, [
      {
        name: 'ticketing',
        data: { ticket: 'ticket-1', action: 'csAdminList' },
      },
    ]);
  });
});
