'use strict';

function createRunQueue({ runOnce }) {
  let active = null;
  let wakeResolve = () => {};
  let wakePromise = new Promise((resolve) => {
    wakeResolve = resolve;
  });
  let resident = false;

  function poke() {
    const resolve = wakeResolve;
    wakePromise = new Promise((next) => {
      wakeResolve = next;
    });
    resolve();
  }

  function kick() {
    if (active) {
      return { started: false, done: Promise.resolve() };
    }
    const outcomes = [];
    const done = (async () => {
      try {
        for (;;) {
          const outcome = await runOnce();
          outcomes.push(outcome);
          if (outcome === 'idle') {
            break;
          }
        }
        return outcomes;
      } finally {
        active = null;
      }
    })();
    active = done;
    return { started: true, done };
  }

  return {
    poke,
    isResident() {
      return resident;
    },
    markResident(activeResident) {
      resident = activeResident === true;
    },
    untilWake(sleep, intervalMs) {
      return Promise.race([sleep(intervalMs), wakePromise]);
    },
    start() {
      return kick();
    },
    async run() {
      const started = kick();
      if (!started.started) {
        return { started: false };
      }
      return { started: true, outcomes: await started.done };
    },
  };
}

async function keepClaiming(queue, sleep, intervalMs, rounds = Infinity) {
  queue.markResident(true);
  try {
    for (let round = 0; round < rounds; round += 1) {
      await queue.run();
      if (round + 1 < rounds) {
        await queue.untilWake(sleep, intervalMs);
      }
    }
  } finally {
    queue.markResident(false);
  }
}

module.exports = { createRunQueue, keepClaiming };
