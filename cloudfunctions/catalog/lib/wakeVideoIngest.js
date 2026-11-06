'use strict';

function jobNeedsWake(job, now, timeoutMs) {
  if (!job) return false;
  if (job.phase === 'queued') return true;
  if (job.phase !== 'running') return false;
  return now - Number(job.claimedAt || 0) >= timeoutMs;
}

function shouldWakeAfterRequeue(enqueued, job, now, timeoutMs) {
  const count = Number(enqueued);
  if (Number.isFinite(count) && count > 0) return true;
  return jobNeedsWake(job, now, timeoutMs);
}

function failureCode(error, response) {
  const body = response && response.data;
  if (body && typeof body.code === 'string' && body.code) {
    return body.code;
  }
  const statusCode = Number(response && response.statusCode);
  if (Number.isFinite(statusCode) && statusCode >= 400) {
    return 'HTTP_' + statusCode;
  }
  if (error && error.errCode !== undefined && error.errCode !== null && error.errCode !== '') {
    return String(error.errCode);
  }
  if (error && typeof error.code === 'string' && error.code) {
    return error.code;
  }
  return 'WAKE_FAILED';
}

function callFailed(response) {
  const statusCode = Number(response && response.statusCode);
  if (Number.isFinite(statusCode) && statusCode >= 400) return true;
  const body = response && response.data;
  return Boolean(body && body.ok === false);
}

async function wakeVideoIngest(callContainer) {
  try {
    const response = await callContainer({
      path: '/run',
      method: 'POST',
      header: { 'X-WX-SERVICE': 'video-ingest' },
      data: {},
    });
    if (callFailed(response)) {
      const code = failureCode(null, response);
      console.error('video-ingest wake failed', code);
      return { woke: false, code };
    }
    return { woke: true, code: '' };
  } catch (error) {
    const code = failureCode(error, null);
    console.error('video-ingest wake failed', code);
    return { woke: false, code };
  }
}

module.exports = { jobNeedsWake, shouldWakeAfterRequeue, wakeVideoIngest };
