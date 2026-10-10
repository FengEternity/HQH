'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createRunQueue, keepClaiming } = require('./runQueue');

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

describe('keepClaiming', () => {
  it('claims again after the queue goes idle', async () => {
    let calls = 0;
    const queue = createRunQueue({
      runOnce: async () => {
        calls += 1;
        return 'idle';
      },
    });
    const sleeps = [];
    await keepClaiming(queue, (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    }, 15000, 3);

    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [15000, 15000]);
  });

  it('poke starts the next claim without waiting out the interval', async () => {
    let calls = 0;
    const queue = createRunQueue({
      runOnce: async () => {
        calls += 1;
        return 'idle';
      },
    });
    let waiting = false;
    const done = keepClaiming(
      queue,
      () => {
        waiting = true;
        return new Promise(() => {});
      },
      15000,
      2,
    );
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (waiting) {
          clearInterval(timer);
          resolve();
        }
      }, 0);
    });
    assert.equal(calls, 1);
    queue.poke();
    await done;
    assert.equal(calls, 2);
  });
});
