'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createTask, driveIndexTask } = require('./indexTask');

function taskOver(count) {
  const ids = [];
  for (let index = 0; index < count; index += 1) ids.push('v' + index);
  return createTask({ taskId: 't', taskType: 'brandRename', videoIds: ids, now: 0 });
}

const noSave = async () => {};

describe('driveIndexTask', () => {
  it('embeds every queued video in one call when work fits the budget', async () => {
    const embedded = [];
    const view = await driveIndexTask({
      task: taskOver(5),
      budgetMs: 1000,
      now: () => 0,
      indexOne: async (id) => { embedded.push(id); return { id, kind: 'success' }; },
      saveTask: noSave,
    });
    assert.equal(embedded.length, 5);
    assert.equal(view.status, 'completed');
    assert.equal(view.ready, 5);
  });

  it('stops at the budget and keeps the cursor for a later advance', async () => {
    let tick = -1;
    const view = await driveIndexTask({
      task: taskOver(10),
      budgetMs: 3,
      now: () => { tick += 1; return tick; },
      indexOne: async (id) => ({ id, kind: 'success' }),
      saveTask: noSave,
    });
    assert.equal(view.status, 'running');
    assert.ok(view.cursor);
  });

  it('counts a failed video and keeps driving the rest', async () => {
    const view = await driveIndexTask({
      task: taskOver(3),
      budgetMs: 1000,
      now: () => 0,
      indexOne: async (id) => ({ id, kind: id === 'v1' ? 'failed' : 'success', error: id === 'v1' ? 'embed_timeout' : '' }),
      saveTask: noSave,
    });
    assert.equal(view.status, 'partial');
    assert.equal(view.ready, 2);
    assert.equal(view.failed, 1);
  });
});
