'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createVideoDocExecutor, probeAgentModel, resolveAgentModelName } = require('./videoDocModel');
const { runVideoDocTurn } = require('./videoDocTurn');

function modelEnv(overrides) {
  return Object.assign(
    {
      TOKENHUB_BASE_URL: 'https://tokenhub.example/v1',
      TOKENHUB_API_KEY: 'intro-key',
      TOKENHUB_MODEL: 'hy3-intro',
      AGENT_MODEL_BASE_URL: 'https://agent-model.example/v1',
      AGENT_MODEL_API_KEY: 'agent-key',
    },
    overrides,
  );
}

function createAi(generateText) {
  const registered = [];
  return {
    registerFunctionTool(tool) {
      registered.push(tool);
    },
    createModel(provider) {
      assert.equal(provider, 'cloudbase');
      return {
        generateText(input, options) {
          return generateText(input, options, registered);
        },
      };
    },
  };
}

function publishedTurn(createAiImpl) {
  return runVideoDocTurn({
    videoId: 'vid-1',
    actor: { type: 'end_user', id: 'user-1' },
    text: '怎么整平',
    requestId: 'req-model-1',
    currentTimeSec: 12,
    loadVideo: async () => ({
      status: 'published',
      title: '全站仪设站',
      intro: '先整平再对中',
      tags: ['设站'],
      brandName: '华测',
      modelName: 'i90',
    }),
    loadLinkedProducts: async () => [
      { id: 'sku-1', name: '脚架', priceFen: 100, status: 'published' },
    ],
    executor: createVideoDocExecutor({ env: modelEnv(), createAi: createAiImpl }),
  });
}

describe('resolveAgentModelName', () => {
  it('uses hy3 from the cloud model list and ignores tokenhub settings', () => {
    assert.equal(resolveAgentModelName(modelEnv()), 'hy3');
    assert.equal(resolveAgentModelName(modelEnv({ AGENT_MODEL_NAME: 'hy-role' })), 'hy3');
    assert.equal(resolveAgentModelName(modelEnv({ AGENT_MODEL_NAME: 'hy4-preview' })), 'hy4-preview');
    assert.equal(
      resolveAgentModelName(modelEnv({ AGENT_MODEL_NAME: 'deepseek-v4.1-flash-1017' })),
      'deepseek-v4.1-flash-1017',
    );
    assert.equal(resolveAgentModelName({ TOKENHUB_MODEL: 'hy3-intro' }), 'hy3');
  });
});

describe('createVideoDocExecutor', () => {
  it('calls the bound video through the cloud model and drops unknown cards', async () => {
    let seenArgs;
    const result = await publishedTurn(() =>
      createAi(async (input, options, registered) => {
        assert.equal(input.model, 'hy3');
        assert.equal(input.thinking, undefined);
        assert.equal(input.maxSteps, 5);
        assert.equal(options.timeout, 20000);
        assert.equal(JSON.stringify(input.messages).includes('user-1'), false);
        assert.equal(JSON.stringify(input.messages).includes('intro-key'), false);
        assert.equal(JSON.stringify(input.messages).includes('agent-key'), false);
        seenArgs = { videoId: 'vid-other' };
        await registered[0].fn(seenArgs);
        return {
          text: '先整平。\n```json\n{"cards":[{"type":"shop_product","id":"sku-1"},{"type":"shop_product","id":"sku-x"}]}\n```',
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        };
      }),
    );

    assert.equal(result.ok, true);
    assert.equal(result.text, '先整平。');
    assert.deepEqual(result.cards, [{ type: 'shop_product', id: 'sku-1' }]);
    assert.equal(seenArgs.videoId, 'vid-other');
  });

  it('stops when the model keeps calling the tool past the cap', async () => {
    const executor = createVideoDocExecutor({
      env: modelEnv(),
      createAi: () =>
        createAi(async (input, options, registered) => {
          let error;
          for (let i = 0; i < 6; i += 1) {
            try {
              await registered[0].fn({});
            } catch (caught) {
              error = caught;
              break;
            }
          }
          return { text: '', error };
        }),
    });
    await assert.rejects(
      () =>
        runVideoDocTurn({
          videoId: 'vid-1',
          actor: { type: 'end_user' },
          text: '怎么整平',
          requestId: 'req-model-2',
          loadVideo: async () => ({ status: 'published', title: '设站', intro: '先整平' }),
          loadLinkedProducts: async () => [],
          executor,
        }),
      (error) => error && error.code === 'TIMEOUT',
    );
  });

  it('returns no executor when the cloud ai client is missing', () => {
    assert.equal(createVideoDocExecutor({ env: modelEnv() }), null);
    assert.equal(createVideoDocExecutor({ env: modelEnv(), createAi: () => null }), null);
  });

  it('uses the saved place model and falls back when that read fails', async () => {
    const saved = createVideoDocExecutor({
      env: modelEnv({ AGENT_MODEL_NAME: 'hy3' }),
      createAi: () => createAi(async (input) => ({ text: '好', usage: {} })),
      loadModelName: async () => 'deepseek-v4.1-flash-1017',
    });
    const savedResult = await saved({
      tools: { lookup_current_video_doc: async () => ({ products: [] }) },
      projection: {},
      text: '测试',
    });
    assert.equal(savedResult.model, 'deepseek-v4.1-flash-1017');

    const fallback = createVideoDocExecutor({
      env: modelEnv({ AGENT_MODEL_NAME: 'deepseek-v4.1-flash-1017' }),
      createAi: () => createAi(async (input) => ({ text: '好', usage: {} })),
      loadModelName: async () => {
        throw new Error('db down');
      },
    });
    const fallbackResult = await fallback({
      tools: { lookup_current_video_doc: async () => ({ products: [] }) },
      projection: {},
      text: '测试',
    });
    assert.equal(fallbackResult.model, 'deepseek-v4.1-flash-1017');
  });
});

describe('probeAgentModel', () => {
  it('calls the listed model without tools and hides vendor errors', async () => {
    const ok = await probeAgentModel({
      modelName: 'hy3',
      createAi: () =>
        createAi(async (input, options) => {
          assert.equal(input.model, 'hy3');
          assert.equal(input.tools, undefined);
          assert.equal(input.thinking, undefined);
          assert.equal(options.timeout, 20000);
          assert.equal(input.messages[0].content, '回复一个字：好');
          return { text: '好' };
        }),
    });
    assert.equal(ok.text, '好');
    await assert.rejects(
      () =>
        probeAgentModel({
          modelName: 'hy-role',
          createAi: () => createAi(async () => ({ text: '好' })),
        }),
      (error) => error && error.code === 'BAD_INPUT',
    );
    await assert.rejects(
      () =>
        probeAgentModel({
          modelName: 'hy3',
          createAi: () =>
            createAi(async () => {
              throw new Error('AI+ 请求出错，错误码：INVALID_MODEL，错误信息：sk-live');
            }),
        }),
      (error) =>
        error &&
        error.code === 'MODEL_UNAVAILABLE' &&
        error.publicMessage === '模型调用失败：INVALID_MODEL' &&
        !String(error.publicMessage).includes('sk-live'),
    );
    await assert.rejects(
      () =>
        probeAgentModel({
          modelName: 'hy3',
          createAi: () =>
            createAi(async () => {
              const error = new Error('sk-live');
              error.code = 'FailedOperation.AIModelNotFound';
              throw error;
            }),
        }),
      (error) =>
        error &&
        error.publicMessage === '模型调用失败：FailedOperation.AIModelNotFound' &&
        !String(error.publicMessage).includes('sk-live'),
    );
    await assert.rejects(
      () =>
        probeAgentModel({
          modelName: 'hy3',
          createAi: () => createAi(async () => ({ text: '' })),
        }),
      (error) => error && error.publicMessage === '模型没有返回文字',
    );
  });
});
