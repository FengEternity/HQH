'use strict';

function uniqueIds(videoIds) {
  const seen = new Set();
  const ids = [];
  for (const raw of videoIds || []) {
    const id = String(raw || '').trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function createTask({ taskId, taskType, videoIds, now }) {
  const ids = uniqueIds(videoIds);
  return {
    taskId,
    taskType,
    videoIds: ids,
    cursor: ids[0] || '',
    total: ids.length,
    successCount: 0,
    failedCount: 0,
    skippedCount: 0,
    counted: {},
    status: ids.length ? 'pending' : 'completed',
    lastError: '',
    updatedAt: now,
  };
}

function nextBatch(task, batchSize) {
  const ids = (task && task.videoIds) || [];
  const cursor = task && task.cursor;
  const start = cursor ? ids.indexOf(cursor) : ids.length;
  const from = start < 0 ? ids.length : start;
  const size = Math.max(1, Number(batchSize) || 1);
  return ids.slice(from, from + size);
}

function applyBatch(task, outcomes, now) {
  const next = Object.assign({}, task, {
    counted: Object.assign({}, task.counted),
    status: 'running',
    lastError: '',
    updatedAt: now,
  });
  const batchFailed = [];
  for (const outcome of outcomes || []) {
    const id = outcome && outcome.id;
    if (!id || next.counted[id] || outcome.kind === 'unchanged') {
      continue;
    }
    next.counted[id] = true;
    if (outcome.kind === 'success') {
      next.successCount += 1;
    } else if (outcome.kind === 'failed') {
      next.failedCount += 1;
      batchFailed.push({ id, error: outcome.error || 'embed_failed' });
    } else {
      next.skippedCount += 1;
    }
  }
  const ids = next.videoIds || [];
  const start = next.cursor ? ids.indexOf(next.cursor) : ids.length;
  const from = start < 0 ? ids.length : start;
  const doneIndex = from + (outcomes || []).length;
  if (doneIndex >= ids.length) {
    next.cursor = '';
    next.status = next.failedCount > 0 ? 'partial' : 'completed';
  } else {
    next.cursor = ids[doneIndex];
    next.status = 'running';
  }
  if (batchFailed.length) {
    next.lastError = batchFailed[0].error;
  }
  next.batchFailed = batchFailed;
  return next;
}

function taskView(task) {
  const view = {
    ok: true,
    taskId: task.taskId,
    status: task.status,
    cursor: task.cursor || '',
    successCount: task.successCount,
    failedCount: task.failedCount,
    skippedCount: task.skippedCount,
    batchFailed: task.batchFailed || [],
  };
  if (task.status === 'completed' || task.status === 'partial') {
    view.ready = task.successCount;
    view.failed = task.failedCount;
    view.skipped = task.skippedCount;
  }
  return view;
}

module.exports = {
  applyBatch,
  createTask,
  nextBatch,
  taskView,
};
