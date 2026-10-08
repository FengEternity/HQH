'use strict';

function createRunQueue({ runOnce }) {
  let active = null;

  return {
    async run() {
      if (active) {
        return { started: false };
      }
      const outcomes = [];
      active = (async () => {
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
      return { started: true, outcomes: await active };
    },
  };
}

module.exports = { createRunQueue };
