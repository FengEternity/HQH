'use strict';

const { videoDocHistory, videoDocSend } = require('./videoDocAction');

async function handleAgentEvent(db, event, deps) {
  const action = event && event.action;
  if (action === 'videoDocHistory') {
    return videoDocHistory(db, {
      openid: deps.openid,
      videoId: event.videoId,
    });
  }
  if (action === 'videoDocSend') {
    return videoDocSend(db, {
      openid: deps.openid,
      videoId: event.videoId,
      text: event.text,
      requestId: event.requestId,
      currentTimeSec: event.currentTimeSec,
      now: deps.now,
      loadVideo: deps.loadVideo,
      loadLinkedProducts: deps.loadLinkedProducts,
      checkContent: deps.checkContent,
      executor: deps.executor,
      exportTrace: deps.exportTrace,
    });
  }
  return { ok: false, code: 'UNKNOWN_ACTION', message: '不支持的操作' };
}

module.exports = { handleAgentEvent };
