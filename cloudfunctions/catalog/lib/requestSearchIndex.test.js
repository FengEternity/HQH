'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { requestSearchIndex } = require('./requestSearchIndex');

describe('requestSearchIndex', () => {
  it('returns the search result and does not throw when the call fails', async () => {
    const calls = [];
    const ok = await requestSearchIndex(async (payload) => {
      calls.push(payload);
      return { result: { ok: true, status: 'stale' } };
    }, {
      action: 'reindexVideo',
    });
    assert.deepEqual(calls, [{ name: 'search', data: { action: 'reindexVideo' } }]);
    assert.equal(ok.status, 'stale');
    const failed = await requestSearchIndex(async () => {
      throw new Error('search 云函数未部署');
    }, { action: 'reindexVideo' });
    assert.deepEqual(failed, { ok: false, code: 'FAIL' });
  });

  it('retries once when the search function reports failure', async () => {
    const calls = [];
    const res = await requestSearchIndex(async (payload) => {
      calls.push(payload);
      return { result: calls.length === 1 ? { ok: false, code: 'FAIL' } : { ok: true, videoId: 'v1' } };
    }, { action: 'reindexVideo', videoId: 'v1' });
    assert.equal(calls.length, 2);
    assert.equal(res.ok, true);
  });

  it('does not retry a bad input', async () => {
    const calls = [];
    const res = await requestSearchIndex(async (payload) => {
      calls.push(payload);
      return { result: { ok: false, code: 'BAD_INPUT' } };
    }, { action: 'reindexVideo' });
    assert.equal(calls.length, 1);
    assert.equal(res.code, 'BAD_INPUT');
  });
});
