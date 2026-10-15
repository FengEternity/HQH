'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  visitorCatalogMessage,
  shouldAutoRetryCatalog,
  callWithVisitorRetry,
} = require('./catalogVisitorError');

describe('visitorCatalogMessage', () => {
  it('uses a visitor sentence for a failed home catalog', () => {
    assert.equal(visitorCatalogMessage('load'), '目录暂时打不开，请再试一次');
  });

  it('uses a visitor sentence for a failed search', () => {
    assert.equal(visitorCatalogMessage('search'), '搜索暂时不可用，请再试一次');
  });
});

describe('shouldAutoRetryCatalog', () => {
  it('retries a transient cloud call failure once', () => {
    const err = new Error('catalog 调用失败');
    err.code = 'FAIL';
    assert.equal(shouldAutoRetryCatalog(err), true);
  });

  it('does not retry when the cloud function is not deployed', () => {
    const err = new Error('catalog 云函数未部署');
    err.code = 'FUNCTION_NOT_FOUND';
    assert.equal(shouldAutoRetryCatalog(err), false);
  });

  it('does not retry when cloud function dependencies are missing', () => {
    const err = new Error('catalog 云函数依赖未安装，请云端安装依赖后重部署');
    err.code = 'FUNCTION_DEPS_MISSING';
    assert.equal(shouldAutoRetryCatalog(err), false);
  });
});

describe('callWithVisitorRetry', () => {
  it('returns the second result after one transient failure', async () => {
    let calls = 0;
    const result = await callWithVisitorRetry(async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('catalog 调用失败');
        err.code = 'FAIL';
        throw err;
      }
      return { ok: true, brands: [] };
    });
    assert.equal(calls, 2);
    assert.deepEqual(result, { ok: true, brands: [] });
  });

  it('throws the second error when the retry also fails', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        callWithVisitorRetry(async () => {
          calls += 1;
          const err = new Error('catalog 调用失败');
          err.code = -504003;
          throw err;
        }),
      (err) => err.code === -504003,
    );
    assert.equal(calls, 2);
  });

  it('does not call again when the function is not deployed', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        callWithVisitorRetry(async () => {
          calls += 1;
          const err = new Error('catalog 云函数未部署');
          err.code = 'FUNCTION_NOT_FOUND';
          throw err;
        }),
      (err) => err.code === 'FUNCTION_NOT_FOUND',
    );
    assert.equal(calls, 1);
  });
});
