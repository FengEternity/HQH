'use strict';

const RUN_ID = /^[A-Za-z0-9_-]{8,64}$/;
const COLLECTION = 'search_traces';

function validRunId(runId) {
  return RUN_ID.test(String(runId || ''));
}

function applyTraceStep(steps, step) {
  const list = Array.isArray(steps) ? steps.slice() : [];
  if (!step || !step.key) {
    return list;
  }
  const next = {
    key: String(step.key),
    label: String(step.label || ''),
    state: step.state === 'done' ? 'done' : 'running',
    detail: String(step.detail || ''),
  };
  const index = list.findIndex((item) => item.key === next.key);
  if (index >= 0) {
    list[index] = next;
    return list;
  }
  list.push(next);
  return list;
}

function createTraceWriter({ db, runId, write }) {
  const persist = write || writeSearchTrace;
  if (!validRunId(runId)) {
    return async function emit() {};
  }
  let steps = [];
  let chain = Promise.resolve();
  return function emit(step) {
    chain = chain.then(async () => {
      steps = applyTraceStep(steps, step);
      try {
        await persist(db, runId, steps);
      } catch (error) {
        return;
      }
    });
    return chain;
  };
}

async function writeSearchTrace(db, runId, steps) {
  const payload = { data: { steps, updatedAt: Date.now() } };
  try {
    await db.collection(COLLECTION).doc(runId).set(payload);
  } catch (error) {
    try {
      await db.createCollection(COLLECTION);
    } catch (createError) {
      // 集合已经在就直接再写一次。
    }
    await db.collection(COLLECTION).doc(runId).set(payload);
  }
}

async function readSearchTrace(db, runId) {
  if (!validRunId(runId)) {
    return [];
  }
  try {
    const snap = await db.collection(COLLECTION).doc(runId).get();
    const steps = snap && snap.data && snap.data.steps;
    return Array.isArray(steps) ? steps : [];
  } catch (error) {
    return [];
  }
}

module.exports = {
  applyTraceStep,
  createTraceWriter,
  readSearchTrace,
  validRunId,
  writeSearchTrace,
};
