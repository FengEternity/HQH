'use strict';

function enqueuedCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) {
    return 0;
  }
  return Math.floor(count);
}

function requeueResultTitle(result) {
  const source = result || {};
  const count = enqueuedCount(source.enqueued);
  if (source.woke) {
    return count > 0 ? '已入队并已唤醒' : '已唤醒，开始处理';
  }
  if (count > 0) {
    return '已入队 ' + count + ' 条，稍后自动处理';
  }
  if (source.idle === false) {
    return '容器未唤醒';
  }
  return '没有需要重处理的视频';
}

module.exports = { requeueResultTitle };
