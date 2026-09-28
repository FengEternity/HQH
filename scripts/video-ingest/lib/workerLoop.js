'use strict';

const FAILURE_MESSAGE = '处理失败';

function jobIdentity(claimed) {
  return {
    videoId: claimed.videoId,
    mediaRevision: claimed.mediaRevision,
  };
}

function mediaPayload(probe) {
  return {
    durationSec: probe.durationSec,
    media: {
      hasAudio: probe.hasAudio,
      videoCodec: probe.videoCodec,
      audioCodec: probe.audioCodec,
      playback: probe.playback,
    },
  };
}

async function completeFailure(catalog, claimed, errorCode) {
  try {
    await catalog.complete({
      ...jobIdentity(claimed),
      outcome: 'failed',
      asr: 'failed',
      errorCode,
      errorMessage: FAILURE_MESSAGE,
    });
  } catch {
    return 'failed';
  }
  return 'failed';
}

// ready 回写失败会把 videos.ingest 永远卡在 running，补一次失败回写让它能落到 failed。
async function completeReady(catalog, claimed, payload) {
  try {
    await catalog.complete(payload);
  } catch {
    return completeFailure(catalog, claimed, 'INTERNAL');
  }
  return 'processed';
}

async function runOnce({
  catalog,
  workerId,
  downloadVideo,
  probeMedia,
  transcodeIfNeeded,
  transcribe,
  resolveAutoIntro,
  placeholderIntro,
  deleteCloudFiles = async () => {},
  warn = () => {},
}) {
  let claimed;
  try {
    claimed = await catalog.claim({ workerId });
  } catch {
    return 'failed';
  }
  if (!claimed || !claimed.job) {
    return 'idle';
  }

  let localPath;
  try {
    localPath = await downloadVideo(claimed.videoFileId);
  } catch {
    return completeFailure(catalog, claimed, 'DOWNLOAD_FAILED');
  }

  let probe;
  try {
    probe = await probeMedia(localPath);
  } catch {
    return completeFailure(catalog, claimed, 'INTERNAL');
  }

  let prepared = { path: localPath };
  if (probe.needsTranscode) {
    try {
      prepared = await transcodeIfNeeded(localPath, probe);
      probe = await probeMedia(prepared.path);
    } catch {
      const result = await completeFailure(catalog, claimed, 'TRANSCODE_FAILED');
      if (prepared.uploadedFileId) {
        try {
          await deleteCloudFiles([prepared.uploadedFileId]);
        } catch {
          warn('云文件清理失败');
        }
      }
      return result;
    }
    if (!probe.playback || probe.playback.compliant !== true) {
      const result = await completeFailure(catalog, claimed, 'TRANSCODE_FAILED');
      if (prepared.uploadedFileId) {
        try {
          await deleteCloudFiles([prepared.uploadedFileId]);
        } catch {
          warn('云文件清理失败');
        }
      }
      return result;
    }
  }

  const cleanupAfterResult = async (result) => {
    if (!prepared.uploadedFileId) {
      return result;
    }
    const fileId =
      result === 'processed' ? claimed.videoFileId : prepared.uploadedFileId;
    try {
      await deleteCloudFiles([fileId]);
    } catch {
      warn('云文件清理失败');
    }
    return result;
  };
  const failPrepared = async (errorCode) =>
    cleanupAfterResult(await completeFailure(catalog, claimed, errorCode));
  const completePrepared = async (payload) =>
    cleanupAfterResult(await completeReady(catalog, claimed, payload));

  const transcoded =
    typeof prepared.uploadedFileId === 'string' && prepared.uploadedFileId
      ? { transcodedVideoFileId: prepared.uploadedFileId }
      : {};
  if (!probe.hasAudio) {
    return completePrepared({
      ...jobIdentity(claimed),
      outcome: 'ready',
      asr: 'skipped',
      ...mediaPayload(probe),
      ...transcoded,
    });
  }

  let transcription;
  try {
    transcription = await transcribe(prepared.path);
  } catch {
    return failPrepared('ASR_FAILED');
  }
  if (!transcription || transcription.ok !== true) {
    return failPrepared('ASR_FAILED');
  }

  if (transcription.skipped) {
    return completePrepared({
      ...jobIdentity(claimed),
      outcome: 'ready',
      asr: 'skipped',
      ...mediaPayload(probe),
      ...transcoded,
    });
  }

  let resolvedIntro;
  try {
    resolvedIntro = resolveAutoIntro({
      transcriptSegments: transcription.segments,
      placeholderIntro,
    });
  } catch {
    return failPrepared('INTERNAL');
  }

  return completePrepared({
    ...jobIdentity(claimed),
    outcome: 'ready',
    asr: 'ready',
    transcriptSegments: transcription.segments,
    ...mediaPayload(probe),
    ...transcoded,
    ...(resolvedIntro.grounded ? { intro: resolvedIntro.intro } : {}),
  });
}

module.exports = {
  runOnce,
};
