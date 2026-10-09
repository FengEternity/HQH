'use strict';

function createRunQueue({ runOnce }) {
  let active = null;

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

module.exports = { createRunQueue };
