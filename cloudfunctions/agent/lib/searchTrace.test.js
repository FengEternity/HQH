'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { applyTraceStep, createTraceWriter, readSearchTrace } = require('./searchTrace');

describe('search trace', () => {
  it('updates a step in place and keeps earlier steps', () => {
    const first = applyTraceStep([], { key: 'understand', label: '理解这句话', state: 'running' });
    const second = applyTraceStep(first, {
      key: 'find:账号设置',
      label: '查找「账号设置」',
      state: 'running',
    });
    const third = applyTraceStep(second, {
      key: 'understand',
      label: '理解这句话',
      state: 'done',
    });
    assert.deepEqual(third.map((step) => `${step.key}:${step.state}`), [
      'understand:done',
      'find:账号设置:running',
    ]);
  });

  it('writes steps in order for one run and ignores a short run id', async () => {
    const writes = [];
    const emit = createTraceWriter({
      db: {},
      runId: 'run-12345678',
      write: async (db, runId, steps) => {
        writes.push({ runId, keys: steps.map((step) => `${step.key}:${step.state}:${step.detail}`) });
      },
    });
    await emit({ key: 'understand', label: '理解这句话', state: 'running' });
    await emit({ key: 'find:账号设置', label: '查找「账号设置」', state: 'done', detail: '找到 1 条' });
    assert.deepEqual(writes.map((item) => item.keys), [
      ['understand:running:'],
      ['understand:running:', 'find:账号设置:done:找到 1 条'],
    ]);
    assert.equal(writes[1].runId, 'run-12345678');

    let called = 0;
    const ignored = createTraceWriter({
      db: {},
      runId: 'short',
      write: async () => {
        called += 1;
      },
    });
    await ignored({ key: 'understand', label: '理解这句话', state: 'running' });
    assert.equal(called, 0);
  });

  it('reads the stored steps and returns nothing for an unknown run', async () => {
    const docs = {
      'run-12345678': { steps: [{ key: 'library', label: '检索已有讲解', state: 'done', detail: '' }] },
    };
    const db = {
      collection(name) {
        assert.equal(name, 'search_traces');
        return {
          doc(id) {
            return {
              get: async () => ({ data: docs[id] }),
            };
          },
        };
      },
    };
    assert.equal((await readSearchTrace(db, 'run-12345678'))[0].label, '检索已有讲解');
    assert.deepEqual(await readSearchTrace(db, 'missing'), []);
    assert.deepEqual(await readSearchTrace(db, 'bad'), []);
  });
});
