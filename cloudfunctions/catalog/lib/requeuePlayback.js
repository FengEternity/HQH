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

module.exports = { needsPlaybackRequeue };
