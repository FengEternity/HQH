'use strict';

const { DEFAULT_MODEL, isListedModel, resolvePlaceModel } = require('./agentModels');
const TOOL_CAP = 5;
const TURN_BUDGET_MS = 20000;
const TOOL_TIMEOUT_MS = 5000;

const LOOKUP_TOOL = {
  name: 'lookup_current_video_doc',
  description: '读取当前这条已发布讲解和它关联的上架商品',
  parameters: { type: 'object', properties: {} },
};

function clean(value) {
  return String(value || '').trim();
}

function resolveAgentModelName(env) {
  return resolvePlaceModel({ place: 'video_doc', stored: null, env });
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function unavailable(publicMessage) {
  const error = coded('MODEL_UNAVAILABLE');
  error.publicMessage = publicMessage;
  return error;
}

function safeFailureCode(value) {
  const code = String(value || '').trim();
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : '';
}

function modelFailure(error) {
  const matched = String((error && error.message) || '').match(/错误码：([A-Za-z0-9_.:-]+)/);
  const code = (matched && matched[1]) || safeFailureCode(error && (error.code || error.errCode));
  if (code) return unavailable('模型调用失败：' + code);
  return coded('MODEL_UNAVAILABLE');
}

function visibleText(content) {
  const raw = Array.isArray(content)
    ? content.map((part) => (part && part.text) || '').join('')
    : String(content || '');
  const withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
  const fence = withoutThink.match(/```json\s*([\s\S]*?)```/);
  const text = withoutThink.replace(/```json\s*[\s\S]*?```/g, '').trim();
  let cards = [];
  if (fence) {
    try {
      const parsed = JSON.parse(fence[1]);
      if (parsed && Array.isArray(parsed.cards)) cards = parsed.cards;
    } catch (error) {
      cards = [];
    }
  }
  return { text, cards };
}

function productCards(doc) {
  return ((doc && doc.products) || [])
    .filter((item) => item && item.id)
    .map((item) => ({ type: 'shop_product', id: String(item.id) }));
}

function usageCount(usage, promptKey, completionKey) {
  const source = usage || {};
  return {
    tokenInput: Number(source[promptKey] || source.promptTokens || source.inputTokens) || 0,
    tokenOutput: Number(source[completionKey] || source.completionTokens || source.outputTokens) || 0,
  };
}

async function withTimeout(work, ms) {
  let timer;
  try {
    return await Promise.race([
      work(),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(coded('TIMEOUT')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runConfiguredTurn({ modelName, createAi, tools, projection, text }) {
  const ai = createAi();
  if (!ai || typeof ai.createModel !== 'function' || typeof ai.registerFunctionTool !== 'function') {
    throw coded('MODEL_UNAVAILABLE');
  }
  const toolResults = [];
  let used = 0;
  const lookupTool = Object.assign({}, LOOKUP_TOOL, {
    fn: async () => {
      used += 1;
      if (used > TOOL_CAP) throw coded('TIMEOUT');
      const doc = await withTimeout(() => tools.lookup_current_video_doc(), TOOL_TIMEOUT_MS);
      toolResults.push({
        name: LOOKUP_TOOL.name,
        resultCode: 'ok',
        cards: productCards(doc),
      });
      return doc;
    },
  });
  ai.registerFunctionTool(lookupTool);
  const model = ai.createModel('cloudbase');
  let result;
  try {
    result = await model.generateText(
      {
        model: modelName,
        messages: [
          {
            role: 'system',
            content:
              '你是讲解页助手。回答前调用 lookup_current_video_doc。只根据工具返回的当前讲解回答，不要引用其他视频。引用商品时，在回答末尾追加 json 代码块 {"cards":[{"type":"shop_product","id":"商品id"}]}，id 必须来自工具结果。',
          },
          {
            role: 'user',
            content:
              (projection && projection.playbackLabel ? '播放位置：' + projection.playbackLabel + '\n' : '') +
              clean(text),
          },
        ],
        temperature: 0.2,
        maxSteps: TOOL_CAP,
        tools: [lookupTool],
      },
      { timeout: TURN_BUDGET_MS },
    );
  } catch (error) {
    if (error && error.code === 'TIMEOUT') throw error;
    throw coded('MODEL_UNAVAILABLE');
  }
  if (result && result.error) {
    if (result.error.code === 'TIMEOUT') throw result.error;
    throw coded('MODEL_UNAVAILABLE');
  }
  const answer = visibleText(result && result.text);
  if (!answer.text) throw coded('MODEL_UNAVAILABLE');
  const usage = usageCount(result && result.usage, 'prompt_tokens', 'completion_tokens');
  return {
    text: answer.text,
    model: modelName,
    tokenInput: usage.tokenInput,
    tokenOutput: usage.tokenOutput,
    toolResults,
    cards: answer.cards,
  };
}

async function probeAgentModel({ modelName, createAi }) {
  if (!isListedModel(modelName)) throw coded('BAD_INPUT');
  let ai;
  try {
    ai = typeof createAi === 'function' ? createAi() : null;
  } catch (error) {
    throw unavailable('云函数未提供 cloud.ai()');
  }
  if (!ai || typeof ai.createModel !== 'function') throw unavailable('云函数未提供 cloud.ai()');
  const model = ai.createModel('cloudbase');
  let result;
  try {
    result = await model.generateText(
      {
        model: modelName,
        messages: [{ role: 'user', content: '回复一个字：好' }],
        temperature: 0,
        maxSteps: 1,
      },
      { timeout: TURN_BUDGET_MS },
    );
  } catch (error) {
    if (error && error.code === 'TIMEOUT') throw error;
    throw modelFailure(error);
  }
  if (result && result.error) {
    if (result.error.code === 'TIMEOUT') throw result.error;
    throw modelFailure(result.error);
  }
  const answer = visibleText(result && result.text);
  if (!answer.text) throw unavailable('模型没有返回文字');
  return { model: modelName, text: answer.text.slice(0, 40) };
}

function createVideoDocExecutor(options) {
  const createAi = options && options.createAi;
  if (typeof createAi !== 'function') return null;
  try {
    if (!createAi()) return null;
  } catch (error) {
    return null;
  }
  const env = options.env;
  const loadModelName = options.loadModelName;
  return async function executor(input) {
    let modelName = resolveAgentModelName(env);
    if (typeof loadModelName === 'function') {
      try {
        const loaded = await loadModelName();
        if (isListedModel(loaded)) modelName = loaded;
      } catch (error) {
        modelName = resolveAgentModelName(env);
      }
    }
    return runConfiguredTurn({
      modelName,
      createAi,
      tools: input.tools,
      projection: input.projection,
      text: input.text,
    });
  };
}

module.exports = {
  resolveAgentModelName,
  createVideoDocExecutor,
  probeAgentModel,
  DEFAULT_MODEL,
};
