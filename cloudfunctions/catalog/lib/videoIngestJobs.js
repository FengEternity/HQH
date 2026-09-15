'use strict';

function canEnqueue(phase) {
  return phase !== 'queued' && phase !== 'running';
}

function createJobRecord({ videoId, mediaRevision, now }) {
  return {
    videoId,
    mediaRevision,
    phase: 'queued',
    claimedAt: 0,
    claimedBy: '',
    createdAt: now,
    updatedAt: now,
  };
}

function claimJobRecord({ job, workerId, now, timeoutMs }) {
  if (job.phase === 'queued') {
    return {
      ...job,
      phase: 'running',
      claimedAt: now,
      claimedBy: workerId,
      updatedAt: now,
    };
  }
  if (job.phase === 'running' && now - job.claimedAt >= timeoutMs) {
    return {
      ...job,
      phase: 'running',
      claimedAt: now,
      claimedBy: workerId,
      updatedAt: now,
    };
  }
  return null;
}

function finishJobRecord({ job, now, phase }) {
  return {
    ...job,
    phase,
    updatedAt: now,
  };
}

module.exports = {
  canEnqueue,
  createJobRecord,
  claimJobRecord,
  finishJobRecord,
};
