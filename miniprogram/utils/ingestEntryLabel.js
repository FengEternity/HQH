'use strict';

function count(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  return n;
}

function ingestEntryLabel(input) {
  const source = input || {};
  if (source.failedToLoad) {
    return '进入';
  }
  const running = count(source.running);
  const queued = count(source.queued);
  const failed = count(source.failed);
  if (running > 0) {
    return '正在转';
  }
  if (queued > 0) {
    return queued + ' 条排队';
  }
  if (failed > 0) {
    return failed + ' 条失败';
  }
  return '进入';
}

module.exports = { ingestEntryLabel };
