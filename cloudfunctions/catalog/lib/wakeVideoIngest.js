'use strict';

function jobNeedsWake(job, now, timeoutMs) {
  if (!job) return false;
  if (job.phase === 'queued') return true;
  if (job.phase !== 'running') return false;
  return now - Number(job.claimedAt || 0) >= timeoutMs;
}

async function wakeVideoIngest(callContainer) {
  try {
    await callContainer({
      path: '/run',
      method: 'POST',
      header: { 'X-WX-SERVICE': 'video-ingest' },
      data: {},
    });
    return true;
  } catch {
    return false;
  }
}

module.exports = { jobNeedsWake, wakeVideoIngest };
