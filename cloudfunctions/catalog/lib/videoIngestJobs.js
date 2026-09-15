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

function badFinishPhase(phase) {
  const err = new Error(`finishJobRecord phase must be done or dead, got: ${phase}`);
  err.code = 'BAD_INPUT';
  return err;
}

function finishJobRecord({ job, now, phase }) {
  if (phase !== 'done' && phase !== 'dead') {
    throw badFinishPhase(phase);
  }
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
