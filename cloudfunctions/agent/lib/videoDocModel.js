'use strict';

const { isListedModel, resolvePlaceModel } = require('./agentModels');
const { createTokenHubClient, chatStatus } = require('./ai-runtime');
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

const VIDEO_DOC_SYSTEM = [
  '你是讲解页助手。回答前调用 lookup_current_video_doc。只根据当前讲解回答用户的问题，不要引用其他视频。',
  '正文写给正在看视频的人：直接回答所问。步骤用「1. 」列表，菜单和按键用 **加粗**。',
  '不要提及工具、字段、数组、代码，也不要说工具返回了什么。不要按标题、简介、品牌逐项复述。',
  '只有用户问购买或商品时，才说明有没有在售商品；没有就用一句话。',
  '有商品时，在回答末尾追加 json 代码块 {"cards":[{"type":"shop_product","id":"商品id"}]}，id 必须来自工具结果。',
  '用户问其他视频或其他型号时，请他回到讲解搜索或打开对应播放页。',
].join('');

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

function scrubAnswer(text) {
  let out = String(text || '');
  out = out.replace(/[（(][^）)\n]{0,160}(?:工具返回|空数组|products)[^）)\n]{0,160}[）)]/gi, '');
  out = out.replace(/工具返回的?\s*[`']?products[`']?\s*为空数组/gi, '');
  out = out.replace(/[，,]?\s*也?没有返回任何关联的其他视频[。.]?/g, '');
  out = out.replace(/^当前视频信息如下[：:]?\s*$/gm, '');
  out = out.replace(/^[-*•]\s*(?:\*\*)?(?:标题|简介|品牌)(?:\*\*)?\s*[：:].*$/gm, '');
  out = out.replace(/^[-*•]\s*(?:\*\*)?讲解内容(?:\*\*)?\s*[：:]\s*/gm, '');
  out = out.replace(/[（(]\s*[）)]/g, '');
  out = out.replace(/[，,]\s*([。．])/g, '$1');
  out = out.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/[ \t]+\n/g, '\n');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
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
    { role: 'system', content: VIDEO_DOC_SYSTEM },
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
      const text = scrubAnswer(answer.text);
      if (!toolResults.length || !text) throw coded('MODEL_UNAVAILABLE');
      return { text, cards: answer.cards, toolResults, model: result.model,
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
    console.error('model probe failed', error && error.code || '', error && error.status || '', error && error.reason || '');
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
  if (!chatStatus(env).ready) return null;
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

module.exports = { resolveAgentModelName, createVideoDocExecutor, probeAgentModel, visibleText, scrubAnswer, LOOKUP_TOOL, VIDEO_DOC_SYSTEM };
