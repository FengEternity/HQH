'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('./cloudRunServer');
const { createProbeProof } = require('./lib/ai-runtime');

function request(server, path, proof) {
  return new Promise(resolve => {
    server.emit('request', { method: 'POST', url: path, headers: { 'x-hqh-ai-proof': proof } }, {
      writeHead() {}, end(text) { resolve(JSON.parse(text)); },
    });
  });
}

test('云托管自检在缺配置时不假报可用，也不泄露配置值', async () => {
  const { server } = createServer({ env: {} });
  assert.deepEqual(await request(server, '/ai/probe'), { ok: false, code: 'NOT_CONFIGURED' });
  server.close();
});

test('简介自检读取同一场景配置，在容器本身发起固定模型请求', async () => {
  const env = { TCB_API_KEY: 'fixture-key', TCB_ENV_ID: 'env', TCB_SECRET_ID: 'id', TCB_SECRET_KEY: 'secret', ADMIN_PIN: 'pin' };
  const { server } = createServer({ env, createApp: () => ({ database: () => ({ collection: () => ({ doc: () => ({ get: async () => ({ data: { video_intro: 'hy4-preview' } }) }) }) }) }),
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'hy4-preview');
      assert.equal(body.messages[0].content, '回复一个字：好');
      return { status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '好' } }] }) };
    },
  });
  assert.deepEqual(await request(server, '/ai/probe'), { ok: false, code: 'UNAUTHORIZED' });
  const result = await request(server, '/ai/probe', createProbeProof(env.ADMIN_PIN));
  assert.equal(result.ok, true);
  assert.equal(result.runtime, 'video-ingest');
  assert.equal(result.model, 'hy4-preview');
  assert.equal(JSON.stringify(result).includes('fixture-key'), false);
  server.close();
});
