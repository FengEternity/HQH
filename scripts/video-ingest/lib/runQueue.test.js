'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createRunQueue } = require('./runQueue');

describe('createRunQueue', () => {
  it('does not start a second loop while one is running', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const queue = createRunQueue({
      runOnce: async () => {
        calls += 1;
        if (calls === 1) {
          await gate;
          return 'processed';
        }
        return 'idle';
      },
    });
    const first = queue.run();
    const second = await queue.run();
    assert.deepEqual(second, { started: false });
    release();
    const finished = await first;
    assert.equal(finished.started, true);
    assert.deepEqual(finished.outcomes, ['processed', 'idle']);
  });

  it('start returns before the current job finishes', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const queue = createRunQueue({
      runOnce: async () => {
        calls += 1;
        if (calls === 1) {
          await gate;
          return 'processed';
        }
        return 'idle';
      },
    });

    const started = queue.start();
    assert.equal(started.started, true);
    assert.equal(calls, 1);
    assert.equal(queue.start().started, false);
    release();
    await started.done;
  });
});
