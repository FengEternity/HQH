'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createVideoDocExecutor, probeAgentModel, resolveAgentModelName, scrubAnswer, VIDEO_DOC_SYSTEM } = require('./videoDocModel');
const { runVideoDocTurn } = require('./videoDocTurn');
const env = { TCB_ENV_ID: 'env-id', TCB_API_KEY: 'fixture-key', TOKENHUB_MODEL: 'hy3' };
const response = (message, usage = { prompt_tokens: 3, completion_tokens: 2 }) => ({ status: 200, text: async () => JSON.stringify({ model: 'hy3', choices: [{ message }], usage }) });
const lookup = { id: 'call-1', type: 'function', function: { name: 'lookup_current_video_doc', arguments: '{}' } };
const turnInput = {
  videoId: 'v1', actor: { type: 'end_user' }, text: '怎么整平', requestId: 'request-1', currentTimeSec: 12,
  loadVideo: async () => ({ status: 'published', title: '设站', intro: '先整平' }),
  loadLinkedProducts: async () => [{ id: 'sku-1', name: '脚架', status: 'published' }],
};

test('播放页通过云开发资源点的工具回合取得当前视频并过滤伪造卡片', async () => {
  const calls = [];
  const executor = createVideoDocExecutor({ env, fetch: async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    assert.equal(url, 'https://env-id.api.tcloudbasegateway.com/v1/ai/cloudbase/chat/completions');
    assert.equal(JSON.stringify(body).includes('fixture-key'), false);
    if (calls.length === 1) return response({ role: 'assistant', content: null, tool_calls: [lookup] });
    assert.equal(body.messages.at(-1).role, 'tool');
    assert.equal(JSON.parse(body.messages.at(-1).content).title, '设站');
    return response({ role: 'assistant', content: '先整平。\n```json\n{"cards":[{"type":"shop_product","id":"sku-1"},{"type":"shop_product","id":"foreign"}]}\n```' });
  }});
  const result = await runVideoDocTurn({ ...turnInput, executor });
  assert.equal(result.text, '先整平。');
  assert.deepEqual(result.cards, [{ type: 'shop_product', id: 'sku-1' }]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].messages[0].content, VIDEO_DOC_SYSTEM);
  assert.equal(VIDEO_DOC_SYSTEM.includes('不要提及工具'), true);
  assert.equal(VIDEO_DOC_SYSTEM.includes('lookup_current_video_doc'), true);
  assert.equal(calls[0].tool_choice, 'auto');
  assert.equal(calls[0].messages.at(-1).content.includes('设站'), true);
  assert.deepEqual(calls[0].thinking, { type: 'disabled' });
  assert.equal(calls[0].messages.at(-1).content.includes('12'), true);
});

test('用户可见答案去掉工具内部说法和字段清单', () => {
  const raw = [
    '根据当前这条讲解视频的信息，**没有关联的上架商品**（工具返回的 `products` 为空数组），也没有返回任何关联的其他视频。',
    '',
    '当前视频信息如下：',
    '- **标题**：中海达仪器一键固定设置',
    '- **简介**：在手簿软件配置基准、差分等参数。',
    '- **品牌**：中海达',
    '- **讲解内容**：打开 High Survey 软件 → 点击"一键固定"',
  ].join('\n');
  const text = scrubAnswer(raw);
  assert.equal(text.includes('工具'), false);
  assert.equal(text.includes('products'), false);
  assert.equal(text.includes('标题'), false);
  assert.equal(text.includes('简介'), false);
  assert.equal(text.includes('品牌'), false);
  assert.equal(text.includes('当前视频信息如下'), false);
  assert.equal(text.includes('没有关联的上架商品'), true);
  assert.equal(text.includes('打开 High Survey 软件'), true);
});

test('未配置返回无执行器，模型选择沿用数据库并兼容环境回退', async () => {
  assert.equal(createVideoDocExecutor({ env: {} }), null);
  assert.equal(resolveAgentModelName(env), 'hy3');
  const calls = [];
  const executor = createVideoDocExecutor({ env, loadModelName: async () => 'deepseek-v4.1-flash-1017', fetch: async (url, options) => {
    calls.push(JSON.parse(options.body));
    return calls.length === 1 ? response({ role: 'assistant', tool_calls: [lookup] }) : response({ content: '答' });
  }});
  await runVideoDocTurn({ ...turnInput, executor });
  assert.equal(calls[0].model, 'deepseek-v4.1-flash-1017');
});

test('工具调用超限停止，未知工具和未取依据的答案拒绝', async () => {
  const make = message => createVideoDocExecutor({ env, fetch: async () => response(message) });
  await assert.rejects(runVideoDocTurn({ ...turnInput, executor: make({ role: 'assistant', tool_calls: [lookup] }) }), { code: 'TIMEOUT' });
  await assert.rejects(runVideoDocTurn({ ...turnInput, executor: make({ role: 'assistant', tool_calls: [{ ...lookup, function: { name: 'shell', arguments: '{}' } }] }) }), { code: 'MODEL_UNAVAILABLE' });
  const direct = await runVideoDocTurn({ ...turnInput, executor: make({ content: '先整平。\n```json\n{"cards":[{"type":"shop_product","id":"sku-1"},{"type":"shop_product","id":"foreign"}]}\n```' }) });
  assert.equal(direct.text, '先整平。');
  assert.deepEqual(direct.cards, [{ type: 'shop_product', id: 'sku-1' }]);
});

test('投影里已有讲解时一次模型返回即可', async () => {
  const calls = [];
  const executor = createVideoDocExecutor({ env, fetch: async (url, options) => {
    calls.push(JSON.parse(options.body));
    return response({ content: '先整平' });
  }});
  const result = await runVideoDocTurn({ ...turnInput, executor });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool_choice, 'auto');
  assert.equal(result.text, '先整平');
  assert.deepEqual(result.cards, []);
});

test('运营连通测试调用同一资源点客户端且只返回脱敏错误', async () => {
  const result = await probeAgentModel({ modelName: 'hy3', env, fetch: async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.tools, undefined);
    assert.equal(body.messages[0].content, '回复一个字：好');
    return response({ content: '好' });
  }});
  assert.equal(result.text, '好');
  await assert.rejects(probeAgentModel({ modelName: 'hy-role', env }), { code: 'BAD_INPUT' });
  await assert.rejects(probeAgentModel({ modelName: 'hy3', env: {} }), e => e.code === 'MODEL_UNAVAILABLE' && e.publicMessage.includes('尚未配置'));
  await assert.rejects(probeAgentModel({ modelName: 'hy3', env, fetch: async () => ({ status: 401, text: async () => 'fixture-key' }) }), e => e.code === 'MODEL_UNAVAILABLE' && !JSON.stringify(e).includes('fixture-key'));
});
