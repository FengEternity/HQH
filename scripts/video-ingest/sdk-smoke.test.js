const assert = require('node:assert/strict');
const test = require('node:test');
const cloudbase = require('@cloudbase/node-sdk');

test('锁定的 CloudBase SDK 可离线加载', () => {
  assert.equal(typeof cloudbase.init, 'function');
});
