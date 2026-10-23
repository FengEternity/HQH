'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { exportForsetiTrace } = require('./forsetiTrace');

const turn = {
  requestId: 'req-1',
  agentRunId: 'run-1',
  profileId: 'video_doc',
  profileVersion: 'v1',
  scopeHash: 'scope-hash',
  spans: [
    {
      name: 'gate',
      status: 'ok',
      durationMs: 4,
      enteredModel: false,
      text: '用户原文不该出现',
      openid: 'openid-secret',
    },
    {
      name: 'model',
      status: 'ok',
      durationMs: 20,
      enteredModel: true,
      model: 'stub-model',
      tokenInput: 3,
      tokenOutput: 5,
      prompt: '系统提示词',
    },
    {
      name: 'tool',
      status: 'ok',
      durationMs: 8,
      enteredModel: true,
      toolName: 'lookup_current_video_doc',
      resultCode: 'ok',
      toolArgs: { videoId: 'vid-1' },
    },
  ],
};

describe('exportForsetiTrace', () => {
  it('posts one OTLP tree to forseti without prompt, text, or openid', async () => {
    const calls = [];
    const result = await exportForsetiTrace({
      turn,
      publicKey: 'pk',
      secretKey: 'sk',
      transport: async (request) => {
        calls.push(request);
        return { statusCode: 200 };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    const request = calls[0];
    assert.equal(request.path, '/v1/traces');
    assert.equal(request.method, 'POST');
    assert.equal(request.header['X-WX-SERVICE'], 'forseti');
    assert.equal(request.header['Content-Type'], 'application/json');
    assert.equal(
      request.header.Authorization,
      'Basic ' + Buffer.from('pk:sk').toString('base64'),
    );

    const body = JSON.stringify(request.data);
    assert.equal(body.includes('用户原文不该出现'), false);
    assert.equal(body.includes('openid-secret'), false);
    assert.equal(body.includes('系统提示词'), false);
    assert.equal(body.includes('vid-1'), false);
    assert.equal(body.includes('sk'), false);
    const spans = request.data.resourceSpans[0].scopeSpans[0].spans;
    assert.deepEqual(spans.map((span) => span.name), ['gate', 'model', 'tool']);
    assert.equal(spans[1].parentSpanId, spans[0].spanId);
    assert.equal(spans[0].traceId, spans[1].traceId);
    assert.match(spans[0].traceId, /^[0-9a-f]{32}$/);
    assert.match(spans[0].spanId, /^[0-9a-f]{16}$/);
  });

  it('keeps the user reply when forseti rejects the export', async () => {
    const result = await exportForsetiTrace({
      turn,
      publicKey: 'pk',
      secretKey: 'sk',
      transport: async () => {
        throw new Error('container down');
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TRACE_EXPORT_FAILED');
  });

  it('does not call forseti without project credentials', async () => {
    let called = false;
    const result = await exportForsetiTrace({
      turn,
      transport: async () => {
        called = true;
      },
    });
    assert.equal(called, false);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NO_CREDENTIALS');
  });
});
