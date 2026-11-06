'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('./cloudRunServer');

function request(server, path) {
  return new Promise(resolve => {
    server.emit('request', { method: 'POST', url: path, headers: {} }, {
      writeHead() {}, end(text) { resolve(JSON.parse(text)); },
    });
  });
}

test('容器不再提供模型探测，简介由云函数生成', async () => {
  const { server } = createServer({ env: {} });
  assert.deepEqual(await request(server, '/ai/probe'), { ok: false, code: 'NOT_FOUND' });
  server.close();
});
