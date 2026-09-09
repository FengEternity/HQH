'use strict';

/**
 * 冷启动时若需 initDb，先完成再建首屏请求，避免与 listHome 抢同一云函数队列。
 */
function whenCloudReady(app) {
  if (!app || !app.globalData) {
    return Promise.resolve();
  }
  const ready = app.globalData.cloudReady;
  if (ready && typeof ready.then === 'function') {
    return ready.catch(() => {});
  }
  return Promise.resolve();
}

module.exports = {
  whenCloudReady,
};
