'use strict';

const { isListedModel, resolvePlaceModel } = require('./agentModels');
const { createTokenHubClient, tokenHubStatus } = require('./ai-runtime');
const TOOL_CAP = 5;
const TURN_BUDGET_MS = 20000;
const TOOL_TIMEOUT_MS = 5000;
const LOOKUP_TOOL = {
  type: 'function',
  function: {
    name: 'lookup_current_video_doc',
    description: '读取当前这条已发布讲解和它关联的上架商品',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function resolveAgentModelName(env) {
  return resolvePlaceModel({ place: 'video_doc', stored: null, env });
}

function visibleText(content) {
  const raw = Array.isArray(content) ? content.map(part => (part && part.text) || '').join('') : String(content || '');
  const withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
  const fence = withoutThink.match(/```json\s*([\s\S]*?)```/);
  const text = withoutThink.replace(/```json\s*[\s\S]*?```/g, '').trim();
  let cards = [];
  if (fence) {
    try { cards = JSON.parse(fence[1]).cards || []; } catch { cards = []; }
  }
  return { text, cards: Array.isArray(cards) ? cards : [] };
}

async function withTimeout(work, ms) {
  if (ms <= 0) throw coded('TIMEOUT');
  let timer;
  try {
    return await Promise.race([work(), new Promise((resolve, reject) => { timer = setTimeout(() => reject(coded('TIMEOUT')), ms); })]);
  } finally { clearTimeout(timer); }
}

function modelError(error) {
  if (error && error.code === 'TIMEOUT') return coded('TIMEOUT');
  return coded('MODEL_UNAVAILABLE');
}

async function runConfiguredTurn({ client, modelName, tools, projection, text, now, modelSpans }) {
  const deadline = now() + TURN_BUDGET_MS;
  const messages = [
    { role: 'system', content: '你是讲解页助手。回答前调用 lookup_current_video_doc。只根据工具返回的当前讲解回答，不要引用其他视频。引用商品时，在回答末尾追加 json 代码块 {"cards":[{"type":"shop_product","id":"商品id"}]}，id 必须来自工具结果。' },
    { role: 'user', content: (projection && projection.playbackLabel ? '播放位置：' + projection.playbackLabel + '\n' : '') + String(text || '').trim() },
  ];
  const toolResults = [];
  let used = 0;
  let tokenInput = 0;
  let tokenOutput = 0;
  for (;;) {
    let result;
    try {
      result = await client.chat({ model: modelName, messages, tools: [LOOKUP_TOOL],
        tool_choice: used ? 'auto' : { type: 'function', function: { name: LOOKUP_TOOL.function.name } },
        temperature: 0.2, max_tokens: 1024, thinking: { type: 'disabled' }, deadline, timeoutMs: TURN_BUDGET_MS,
      });
    } catch (error) { throw modelError(error); }
    tokenInput = tokenInput === null || result.usage.input === null ? null : tokenInput + result.usage.input;
    tokenOutput = tokenOutput === null || result.usage.output === null ? null : tokenOutput + result.usage.output;
    const message = result.message;
    const calls = message.tool_calls || [];
    if (!Array.isArray(calls)) throw coded('MODEL_UNAVAILABLE');
    if (!calls.length) {
      const answer = visibleText(message.content);
      if (!toolResults.length || !answer.text) throw coded('MODEL_UNAVAILABLE');
      return { text: answer.text, cards: answer.cards, toolResults, model: result.model,
        tokenInput, tokenOutput, modelSpans };
    }
    messages.push({ ...message, role: 'assistant' });
    for (const call of calls) {
      if (++used > TOOL_CAP) throw coded('TIMEOUT');
      if (!call || !call.id || !call.function || call.function.name !== LOOKUP_TOOL.function.name) throw coded('MODEL_UNAVAILABLE');
      try {
        const args = JSON.parse(call.function.arguments || '{}');
        if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error();
      } catch { throw coded('MODEL_UNAVAILABLE'); }
      const startedAt = now();
      const doc = await withTimeout(() => tools.lookup_current_video_doc(), Math.min(TOOL_TIMEOUT_MS, deadline - now()));
      toolResults.push({ name: LOOKUP_TOOL.function.name, resultCode: 'ok', startedAt,
        durationMs: Math.max(0, now() - startedAt),
        cards: ((doc && doc.products) || []).filter(item => item && item.id).map(item => ({ type: 'shop_product', id: String(item.id) })),
      });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(doc) });
    }
  }
}

async function probeAgentModel({ modelName, env = process.env, fetch }) {
  if (!isListedModel(modelName)) throw coded('BAD_INPUT');
  try {
    const result = await createTokenHubClient({ env, fetch }).chat({ model: modelName,
      messages: [{ role: 'user', content: '回复一个字：好' }], temperature: 0, thinking: { type: 'disabled' }, max_tokens: 32, timeoutMs: TURN_BUDGET_MS });
    const answer = visibleText(result.message.content);
    if (!answer.text) throw coded('BAD_RESPONSE');
    return { model: result.model, text: answer.text.slice(0, 40) };
  } catch (error) {
    if (error && error.code === 'TIMEOUT') throw error;
    const failure = coded('MODEL_UNAVAILABLE');
    const messages = {
      NOT_CONFIGURED: '模型服务尚未配置，请完成服务端接入设置',
      AUTH: '模型服务鉴权失败，请检查服务端接入设置',
      QUOTA: '模型未开通或额度不足，请检查服务端设置',
      RATE_LIMITED: '模型服务繁忙，请稍后再试',
      BAD_RESPONSE: '模型没有返回可用文字',
    };
    failure.publicMessage = messages[error && error.code] || '暂时无法调用，请稍后再试';
    throw failure;
  }
}

function createVideoDocExecutor(options = {}) {
  const env = options.env || process.env;
  if (!tokenHubStatus(env).ready) return null;
  return async input => {
    let modelName = resolveAgentModelName(env);
    if (typeof options.loadModelName === 'function') {
      try {
        const loaded = await options.loadModelName();
        if (isListedModel(loaded)) modelName = loaded;
      } catch { /* 保留场景环境配置。 */ }
    }
    const modelSpans = [];
    const client = createTokenHubClient({ env, fetch: options.fetch, now: options.now,
      onAttempt: span => modelSpans.push({ name: 'model', status: span.code === 'ok' ? 'ok' : 'error',
        enteredModel: true, provider: span.provider, configVersion: span.version, attempt: span.attempt,
        model: span.model, startedAt: span.startedAt, durationMs: span.durationMs,
        resultCode: span.code, tokenInput: span.usage.input, tokenOutput: span.usage.output }),
    });
    try {
      return await runConfiguredTurn({ client, modelName, tools: input.tools, projection: input.projection,
        text: input.text, now: options.now || Date.now, modelSpans });
    } catch (error) {
      error.modelSpans = modelSpans;
      throw error;
    }
  };
}

module.exports = { resolveAgentModelName, createVideoDocExecutor, probeAgentModel, visibleText, LOOKUP_TOOL };
