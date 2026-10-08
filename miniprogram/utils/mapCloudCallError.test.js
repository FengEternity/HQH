'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mapCloudCallError } = require('./mapCloudCallError');

describe('mapCloudCallError', () => {
  it('maps WeChat FUNCTION_NOT_FOUND to a short message', () => {
    const err = mapCloudCallError(
      {
        errCode: -501000,
        errMsg:
          'cloud.callFunction:fail Error: errCode: -501000 | errMsg: FunctionName parameter could not be found. 更多错误信息请访问: https://docs.cloudbase.net/error-code/basic/FUNCTION_NOT_FOUND',
      },
      'shop',
    );
    assert.equal(err.code, 'FUNCTION_NOT_FOUND');
    assert.equal(err.message, 'shop 云函数未部署');
    assert.equal(err.message.indexOf('callFunction') < 0, true);
  });

  it('maps FUNCTION_NOT_FOUND text even without errCode', () => {
    const err = mapCloudCallError(
      { message: 'FUNCTION_NOT_FOUND' },
      'shop',
    );
    assert.equal(err.code, 'FUNCTION_NOT_FOUND');
  });

  it('maps missing wx-server-sdk execute fail to a short message', () => {
    const raw = new Error(
      'cloud.callFunction:fail Error: errCode: -504002 functions execute fail | errMsg: Error: Cannot find module \'wx-server-sdk\'',
    );
    raw.errCode = -504002;
    raw.errMsg = raw.message;
    const err = mapCloudCallError(raw, 'shop');
    assert.equal(err.code, 'FUNCTION_DEPS_MISSING');
    assert.equal(err.message, 'shop 云函数依赖未安装，请云端安装依赖后重部署');
  });
});
