'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolvePlaceModel,
  publicModelConfig,
  assignmentPatch,
  MODELS,
} = require('./agentModels');

describe('agent model list', () => {
  it('keeps only the server list and defaults each place to hy3', () => {
    assert.deepEqual(
      MODELS.map((item) => item.id),
      [
        'hy3',
        'hy4-preview',
        'deepseek-v4.1-flash-1017',
        'deepseek-v4.1-flash',
        'deepseek/deepseek-flash',
        'deepseek-v4-pro',
        'deepseek-v4-pro-0813',
        'glm-5.3-flashx',
        'glm-5.3-flash',
        'glm-5.3',
        'glm-5.2',
        'kimi-k3',
        'kimi-k2.8-preview',
        'kimi-k2.7-code-highspeed',
        'kimi-k2.7-code',
        'kimi-k2.6',
        'minimax-m3',
        'mimo-v2.6-pro',
        'mimo-v2.6-flash',
        'step-5-preview',
      ],
    );
    assert.equal(MODELS.some((item) => item.id === 'hy-role'), false);
    assert.equal(resolvePlaceModel({ place: 'video_doc', stored: null, env: {} }), 'hy3');
    assert.equal(
      resolvePlaceModel({
        place: 'customer_service',
        stored: null,
        env: { AGENT_MODEL_NAME: 'hy-role', TOKENHUB_MODEL: 'hy3-intro' },
      }),
      'hy3',
    );
  });

  it('uses a saved listed model before the env fallback', () => {
    const stored = { video_doc: 'deepseek-v4.1-flash-1017', customer_service: 'not-a-model' };
    assert.equal(
      resolvePlaceModel({
        place: 'video_doc',
        stored,
        env: { AGENT_MODEL_NAME: 'hy3' },
      }),
      'deepseek-v4.1-flash-1017',
    );
    assert.equal(
      resolvePlaceModel({
        place: 'customer_service',
        stored,
        env: { AGENT_MODEL_NAME: 'deepseek-v4.1-flash-1017' },
      }),
      'deepseek-v4.1-flash-1017',
    );
  });

  it('publishes places with the resolved model and rejects unknown assignments', () => {
    const view = publicModelConfig(
      { video_doc: 'deepseek-v4.1-flash-1017' },
      {},
    );
    assert.equal(view.places.find((item) => item.id === 'video_doc').model, 'deepseek-v4.1-flash-1017');
    assert.equal(view.places.find((item) => item.id === 'customer_service').model, 'hy3');
    assert.equal(JSON.stringify(view).includes('secret'), false);
    assert.throws(
      () => assignmentPatch({}, 'video_doc', 'hy-role'),
      (error) => error && error.code === 'BAD_INPUT',
    );
    assert.deepEqual(assignmentPatch({ customer_service: 'hy3' }, 'video_doc', 'deepseek-v4.1-flash-1017'), {
      video_doc: 'deepseek-v4.1-flash-1017',
      customer_service: 'hy3',
    });
  });
});
