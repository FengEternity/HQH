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
  it('loads the saved video model inside the cloud function entry', () => {
    const source = fs.readFileSync(require.resolve('../index.js'), 'utf8');
    assert.equal(source.includes('handleAgentModelAction'), true);
    assert.equal(source.includes("loadPlaceModelName(db, 'video_doc', process.env)"), true);
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
        createAi() {
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
        createAi() {
          return {
            createModel() {
              return {
                generateText() {
                  throw new Error('sk-live');
                },
              };
            },
          };
        },
      },
    );
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.code, 'MODEL_UNAVAILABLE');
    assert.equal(unavailable.message, '暂时无法调用，请稍后再试');

    const missing = await handleAgentModelAction(
      db,
      { action: 'agentModelTest', model: 'hy3' },
      { openid: 'op-1', createAi: () => null },
    );
    assert.equal(missing.message, '云函数未提供 cloud.ai()');
    assert.equal(JSON.stringify(unavailable).includes('sk-live'), false);
  });
});
