'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createTokenHubClient, chatStatus, tokenHubStatus, resolveTextModel, loadTextModel, createServiceProof, verifyServiceProof, createProbeProof, verifyProbeProof, nodeFetch, selectFetch } = require('./index');

const env = { TCB_ENV_ID: 'env-id', TCB_API_KEY: 'fixture-key' };
const embedEnv = { TOKENHUB_API_KEY: 'fixture-key' };
const response = (body, status = 200) => ({ status, text: async () => JSON.stringify(body) });

test('缺少配置时明确未就绪，不发请求也不泄露密钥', async () => {
  assert.deepEqual(chatStatus({}).missing, ['TCB_ENV_ID', 'TCB_API_KEY']);
  assert.equal(chatStatus(env).ready, true);
  assert.equal(JSON.stringify(chatStatus(env)).includes('fixture-key'), false);
  let called = false;
  await assert.rejects(createTokenHubClient({ env: {}, fetch: async () => { called = true; } }).chat({ model: 'hy3', messages: [] }), { code: 'NOT_CONFIGURED' });
  assert.equal(called, false);
  assert.equal(chatStatus({ ...env, TCB_ENV_ID: 'https://evil.example' }).ready, false);
  assert.equal(tokenHubStatus(embedEnv).ready, true);
  assert.equal(tokenHubStatus({ ...embedEnv, TOKENHUB_BASE_URL: 'http://example.com/v1' }).ready, false);
});

test('chat 走云开发资源点通道，保留工具回合并归一化用量', async () => {
  let seen;
  const trace = [];
  const client = createTokenHubClient({ env, onAttempt: (span) => trace.push(span), fetch: async (url, options) => {
    seen = { url, options, body: JSON.parse(options.body) };
    return response({ model: 'hy3-actual', choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] } }], usage: { prompt_tokens: 4, completion_tokens: 2 } });
  }});
  const result = await client.chat({ model: 'hy3', messages: [{ role: 'user', content: 'fixture-prompt' }], tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }] });
  assert.equal(seen.url, 'https://env-id.api.tcloudbasegateway.com/v1/ai/cloudbase/chat/completions');
  assert.equal(trace[0].provider, 'cloudbase');
  assert.equal(seen.options.headers.Authorization, 'Bearer fixture-key');
  assert.equal(result.message.tool_calls[0].id, 'call-1');
  assert.equal(result.model, 'hy3-actual');
  assert.deepEqual(result.usage, { input: 4, output: 2 });
  assert.equal(trace.length, 1);
  assert.equal(JSON.stringify(trace).includes('fixture-prompt'), false);
  assert.equal(JSON.stringify(trace).includes('fixture-key'), false);
});

test('供应商鉴权错误不重试且不透传正文；未知用量保持 null', async () => {
  let count = 0;
  const client = createTokenHubClient({ env, fetch: async () => { count++; return response({ error: { message: 'fixture-key secret-prompt' } }, 401); } });
  await assert.rejects(client.chat({ model: 'hy3', messages: [] }), error => error.code === 'AUTH' && !JSON.stringify(error).includes('fixture-key'));
  assert.equal(count, 1);
  const result = await createTokenHubClient({ env, fetch: async () => response({ choices: [{ message: { content: '好' } }] }) }).chat({ model: 'hy3', messages: [] });
  assert.deepEqual(result.usage, { input: null, output: null });
});

test('取消覆盖响应正文读取，超时会 abort 实际传输', async () => {
  let signal;
  const client = createTokenHubClient({ env, fetch: async (url, options) => {
    signal = options.signal;
    return { status: 200, text: () => new Promise(() => {}) };
  }});
  await assert.rejects(client.chat({ model: 'hy3', messages: [], timeoutMs: 15 }), { code: 'TIMEOUT' });
  assert.equal(signal.aborted, true);
});

test('仅临时状态有限重试；格式错误不当作正常答案', async () => {
  let count = 0;
  const client = createTokenHubClient({ env, sleep: async () => {}, fetch: async () => ++count === 1 ? response({}, 503) : response({ choices: [{ message: { content: '好' } }] }) });
  assert.equal((await client.chat({ model: 'hy3', messages: [] })).message.content, '好');
  assert.equal(count, 2);
  await assert.rejects(createTokenHubClient({ env, fetch: async () => response({}) }).chat({ model: 'hy3', messages: [] }), { code: 'BAD_RESPONSE' });
});

test('embedding 校验维度与数值，不混用错误模型', async () => {
  const make = body => createTokenHubClient({ env: embedEnv, fetch: async () => response(body) });
  const ok = await make({ model: 'embed', data: [{ embedding: [1, 0] }] }).embed({ model: 'embed', input: '文本', dimensions: 2 });
  assert.deepEqual(ok.embedding, [1, 0]);
  await assert.rejects(make({ data: [{ embedding: [1] }] }).embed({ model: 'embed', input: '文本', dimensions: 2 }), { code: 'BAD_DIMENSION' });
  await assert.rejects(make({ model: 'other', data: [{ embedding: [1, 0] }] }).embed({ model: 'embed', input: '文本', dimensions: 2 }), { code: 'BAD_RESPONSE' });
});

test('问答和简介共用场景路由，容器可读取同一份运营配置', async () => {
  const config = { video_intro: 'hy4-preview' };
  const db = { collection(name) { assert.equal(name, 'admin_config'); return { doc(id) { assert.equal(id, 'agent_models'); return { get: async () => ({ data: config }) }; } }; } };
  assert.equal(await loadTextModel(db, 'video_intro', { TOKENHUB_MODEL: 'hy3' }), 'hy4-preview');
  assert.equal(resolveTextModel({ place: 'video_doc', env: { TOKENHUB_VIDEO_DOC_MODEL: 'hy4-preview', TOKENHUB_MODEL: 'hy3' } }), 'hy4-preview');
  assert.equal(resolveTextModel({ place: 'video_intro', env: {} }), 'hy3');
});

test('没有全局 fetch 时用 Node 自带请求完成对话', async () => {
  const seen = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: '好' } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const previous = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    assert.equal(selectFetch(), nodeFetch);
    const result = await nodeFetch(`http://127.0.0.1:${port}/v1/ai/cloudbase/chat/completions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer fixture-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: '回复一个字：好' }] }),
    });
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(await result.text()).choices[0].message.content, '好');
    assert.equal(seen[0].authorization, 'Bearer fixture-key');
    assert.equal(seen[0].body.model, 'hy3');
  } finally {
    globalThis.fetch = previous;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('容器探测凭据绑定用途和短时限，不能伪造或过期使用', () => {
  const now = 1793700000000;
  const proof = createProbeProof('fixture-secret', now);
  assert.equal(verifyProbeProof('fixture-secret', proof, now + 30000), true);
  assert.equal(verifyProbeProof('other-secret', proof, now), false);
  assert.equal(verifyProbeProof('fixture-secret', proof, now + 61000), false);
  assert.equal(verifyProbeProof('fixture-secret', 'invalid', now), false);
  const introProof = createServiceProof('fixture-secret', 'video-ingest:write-intro', now);
  assert.equal(verifyServiceProof('fixture-secret', 'video-ingest:write-intro', introProof, now), true);
  assert.equal(verifyServiceProof('fixture-secret', 'video-ingest:write-intro', proof, now), false);
});
