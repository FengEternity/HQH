'use strict';

const fs = require('fs');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { handleAgentModelAction, loadPlaceModelName } = require('./agentModelAction');

function fakeDb(seed) {
  const store = seed;
  return {
    dump(collection, id) {
      return store[collection] && store[collection][id];
    },
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              const data = store[name] && store[name][id];
              if (!data) {
                const error = new Error('document not found');
                error.errCode = -502005;
                throw error;
              }
              return { data };
            },
            async set({ data }) {
              store[name] = store[name] || {};
              store[name][id] = Object.assign({ _id: id }, data);
            },
          };
        },
      };
    },
  };
}

function staffDb() {
  return fakeDb({
    admin_users: {
      'op-1': { enabled: true, role: 'operator' },
      'admin-1': { enabled: true, role: 'admin' },
      'off-1': { enabled: false, role: 'operator' },
    },
    admin_config: {},
  });
}

describe('agent model actions', () => {
  it('三个场景的测试都在云函数内探测，且先校验人员', async () => {
    const db = staffDb();
    const view = await handleAgentModelAction(db, { action: 'agentModelConfig' }, { openid: 'op-1', env: {} });
    assert.equal(view.connection.ready, false);
    let seen = null;
    const deps = {
      openid: 'op-1',
      env: { TCB_ENV_ID: 'env-id', TCB_API_KEY: 'fixture-key' },
      fetch: async (_url, options) => {
        seen = JSON.parse(options.body);
        return { status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '好' } }] }) };
      },
    };
    const result = await handleAgentModelAction(db, { action: 'agentModelTest', place: 'video_intro', model: 'hy3' }, deps);
    assert.equal(seen.model, 'hy3');
    assert.equal(result.message, '问答服务可以调用');
    seen = null;
    await handleAgentModelAction(db, { action: 'agentModelTest', place: 'video_intro', model: 'hy3' }, { ...deps, openid: 'off-1' });
    assert.equal(seen, null);
  });
  it('loads the saved video model inside the cloud function entry', () => {
    const source = fs.readFileSync(require.resolve('../index.js'), 'utf8');
    assert.equal(source.includes('handleAgentModelAction'), true);
    assert.equal(source.includes('writeVideoIntro'), true);
    assert.equal(source.includes('/ai/probe'), false);
    assert.equal(source.includes("loadPlaceModelName(db, 'video_doc', runtimeEnv())"), true);
  });

  it('lets enabled staff read and save a place without storing secrets or the caller id', async () => {
    const db = staffDb();
    const denied = await handleAgentModelAction(db, { action: 'agentModelConfig', openid: 'op-1' }, {
      openid: '',
      env: {},
    });
    assert.equal(denied.code, 'UNAUTHORIZED');

    const view = await handleAgentModelAction(db, { action: 'agentModelConfig' }, { openid: 'op-1', env: {} });
    assert.equal(view.ok, true);
    assert.equal(view.places.find((item) => item.id === 'video_doc').model, 'hy3');

    const saved = await handleAgentModelAction(
      db,
      { action: 'agentModelSave', place: 'video_doc', model: 'deepseek-v4.1-flash-1017', openid: 'stranger' },
      { openid: 'admin-1', env: { AGENT_MODEL_API_KEY: 'secret' }, now: 20 },
    );
    assert.equal(saved.ok, true);
    assert.equal(saved.places.find((item) => item.id === 'video_doc').model, 'deepseek-v4.1-flash-1017');
    const doc = db.dump('admin_config', 'agent_models');
    assert.equal(doc.video_doc, 'deepseek-v4.1-flash-1017');
    assert.equal(doc.updatedAt, 20);
    assert.equal(JSON.stringify(doc).includes('secret'), false);
    assert.equal(JSON.stringify(doc).includes('admin-1'), false);
    assert.equal(await loadPlaceModelName(db, 'video_doc', {}), 'deepseek-v4.1-flash-1017');
  });

  it('rejects an unlisted model and returns a fixed message when the probe fails', async () => {
    const db = staffDb();
    const bad = await handleAgentModelAction(
      db,
      { action: 'agentModelTest', model: 'hy-role' },
      { openid: 'op-1', env: {} },
    );
    assert.equal(bad.code, 'BAD_INPUT');

    const failed = await handleAgentModelAction(
      db,
      { action: 'agentModelTest', model: 'hy3' },
      {
        openid: 'off-1',
        fetch() {
          throw new Error('should not run');
        },
      },
    );
    assert.equal(failed.code, 'UNAUTHORIZED');

    const unavailable = await handleAgentModelAction(
      db,
      { action: 'agentModelTest', model: 'hy3' },
      {
        openid: 'op-1',
        env: { TCB_ENV_ID: 'env-id', TCB_API_KEY: 'fixture-key' },
        fetch: async () => { throw new Error('sk-live'); },
      },
    );
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.code, 'MODEL_UNAVAILABLE');
    assert.equal(unavailable.message, '暂时无法调用，请稍后再试');

    const missing = await handleAgentModelAction(
      db,
      { action: 'agentModelTest', model: 'hy3' },
      { openid: 'op-1', env: {} },
    );
    assert.equal(missing.message, '模型服务尚未配置，请完成服务端接入设置');
    assert.equal(JSON.stringify(unavailable).includes('sk-live'), false);
  });
});
