'use strict';

function needsPlaybackRequeue(video) {
  if (!video || typeof video !== 'object') {
    return false;
  }
  const fileId = typeof video.videoFileId === 'string' ? video.videoFileId : '';
  if (!fileId) {
    return false;
  }
  const playback = video.media && video.media.playback;
  if (playback && playback.compliant === true) {
    return false;
  }
  const phase = video.ingest && video.ingest.phase;
  if (phase === 'queued' || phase === 'running') {
    return false;
  }
  return true;
}

const PHASE_LABEL = {
  running: '正在转',
  queued: '排队',
  failed: '失败',
};

const PHASE_ORDER = { running: 0, queued: 1, failed: 2 };

function summarizeIngestProgress(videos) {
  const items = [];
  for (const video of Array.isArray(videos) ? videos : []) {
    const phase = video && video.ingest && video.ingest.phase;
    if (!Object.prototype.hasOwnProperty.call(PHASE_LABEL, phase)) {
      continue;
    }
    const title = typeof video.title === 'string' && video.title ? video.title : '未命名';
    items.push({
      id: video._id,
      title,
      phase,
      label: PHASE_LABEL[phase],
    });
  }
  items.sort((left, right) => PHASE_ORDER[left.phase] - PHASE_ORDER[right.phase]);
  return {
    running: items.filter((item) => item.phase === 'running').length,
    queued: items.filter((item) => item.phase === 'queued').length,
    failed: items.filter((item) => item.phase === 'failed').length,
    items,
  };
}

module.exports = { needsPlaybackRequeue, summarizeIngestProgress };
