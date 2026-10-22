'use strict';

const FAILURE_MESSAGE = '处理失败';

function jobIdentity(claimed) {
  return {
    videoId: claimed.videoId,
    mediaRevision: claimed.mediaRevision,
  };
}

function generatedIntroFields(resolved, placeholderIntro) {
  if (!resolved || typeof resolved !== 'object') {
    return {};
  }
  const text = String(resolved.intro || '').replace(/\s+/g, ' ').trim();
  if (!text || text === placeholderIntro) {
    return {};
  }
  const ok = resolved.gateOk === true || (resolved.gateOk == null && resolved.grounded === true);
  return {
    intro: text,
    introGate: {
      ok,
      reason: ok ? '' : String(resolved.gateReason || ''),
    },
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
async function completeReady(catalog, claimed, payload, warn) {
  try {
    await catalog.complete(payload);
  } catch (error) {
    const code = error && error.code ? error.code : '';
    const message = error && error.message ? error.message : 'failed';
    warn(`complete failed: ${code} ${message}`.trim());
    return completeFailure(catalog, claimed, 'INTERNAL');
  }
  return 'processed';
}

function toTenths(value) {
  return Math.round(Number(value) * 10);
}

function fitSegmentsToDuration(segments, durationSec) {
  const upperTenths = toTenths(durationSec);
  if (!Array.isArray(segments) || !(upperTenths > 0)) {
    return Array.isArray(segments) ? segments : [];
  }
  const fitted = [];
  for (const segment of segments) {
    const startTenths = Math.max(0, toTenths(segment && segment.startSec));
    let endTenths = toTenths(segment && segment.endSec);
    const text = segment && typeof segment.text === 'string' ? segment.text.trim() : '';
    if (!text || startTenths >= upperTenths) {
      continue;
    }
    if (endTenths > upperTenths) {
      endTenths = upperTenths;
    }
    if (endTenths <= startTenths) {
      continue;
    }
    fitted.push({
      startSec: startTenths / 10,
      endSec: endTenths / 10,
      text,
    });
  }
  fitted.sort((left, right) => left.startSec - right.startSec);
  return fitted;
}

async function runOnce({
  catalog,
  workerId,
  downloadVideo,
  probeMedia,
  transcodeIfNeeded,
  createCover,
  transcribe,
  summarizeIntro,
  recognizeSpeech,
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

  let remoteSpeech = null;
  if (probe.hasAudio && typeof recognizeSpeech === 'function') {
    try {
      remoteSpeech = await recognizeSpeech({
        localPath,
        title: typeof claimed.title === 'string' ? claimed.title : '',
        brandName: typeof claimed.brandName === 'string' ? claimed.brandName : '',
        durationSec: probe.durationSec,
      });
    } catch (error) {
      warn(`tencent skipped: ${error && error.message ? error.message : 'failed'}`);
      remoteSpeech = null;
    }
    const earlyIntro = generatedIntroFields(remoteSpeech, placeholderIntro);
    if (earlyIntro.intro && typeof catalog.noteIntro === 'function') {
      try {
        await catalog.noteIntro({
          ...jobIdentity(claimed),
          ...earlyIntro,
        });
      } catch (error) {
        warn(`intro note skipped: ${error && error.message ? error.message : 'failed'}`);
      }
    }
  }

  let prepared = { path: localPath };
  if (probe.needsTranscode) {
    try {
      prepared = await transcodeIfNeeded(localPath, probe);
      probe = await probeMedia(prepared.path);
    } catch (error) {
      warn(`transcode failed: ${error && error.message ? error.message : 'failed'}`);
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
      warn('transcode result rejected');
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

  let generatedCoverFileId = '';
  const cleanupAfterResult = async (result) => {
    const fileIds = [];
    if (prepared.uploadedFileId) {
      fileIds.push(
        result === 'processed' ? claimed.videoFileId : prepared.uploadedFileId,
      );
    }
    if (result !== 'processed' && generatedCoverFileId) {
      fileIds.push(generatedCoverFileId);
    }
    if (fileIds.length === 0) {
      return result;
    }
    try {
      await deleteCloudFiles(fileIds);
    } catch {
      warn('云文件清理失败');
    }
    return result;
  };
  const failPrepared = async (errorCode) =>
    cleanupAfterResult(await completeFailure(catalog, claimed, errorCode));
  const completePrepared = async (payload) =>
    cleanupAfterResult(await completeReady(catalog, claimed, payload, warn));

  const transcoded =
    typeof prepared.uploadedFileId === 'string' && prepared.uploadedFileId
      ? { transcodedVideoFileId: prepared.uploadedFileId }
      : {};
  let cover = {};
  if (!claimed.coverFileId && typeof createCover === 'function') {
    try {
      const coverFileId = await createCover(prepared.path, probe);
      if (coverFileId) {
        generatedCoverFileId = coverFileId;
        cover = { coverFileId };
      }
    } catch {
      warn('自动封面生成失败');
    }
  }
  if (!probe.hasAudio) {
    return completePrepared({
      ...jobIdentity(claimed),
      outcome: 'ready',
      asr: 'skipped',
      ...mediaPayload(probe),
      ...transcoded,
      ...cover,
    });
  }

  let transcription;
  const remoteSegments = remoteSpeech && Array.isArray(remoteSpeech.segments)
    ? fitSegmentsToDuration(remoteSpeech.segments, probe.durationSec)
    : [];
  if (remoteSegments.length > 0) {
    transcription = { ok: true, skipped: false, segments: remoteSegments };
  } else try {
    transcription = await transcribe(prepared.path);
  } catch {
    return completePrepared({
      ...jobIdentity(claimed),
      outcome: 'ready',
      asr: 'failed',
      errorMessage: '转写失败，播放文件已更新',
      ...mediaPayload(probe),
      ...transcoded,
      ...cover,
    });
  }
  if (!transcription || transcription.ok !== true) {
    return completePrepared({
      ...jobIdentity(claimed),
      outcome: 'ready',
      asr: 'failed',
      errorMessage: '转写失败，播放文件已更新',
      ...mediaPayload(probe),
      ...transcoded,
      ...cover,
    });
  }

  if (transcription.skipped) {
    return completePrepared({
      ...jobIdentity(claimed),
      outcome: 'ready',
      asr: 'skipped',
      ...mediaPayload(probe),
      ...transcoded,
      ...cover,
    });
  }

  let resolvedIntro = { grounded: false };
  if (remoteSpeech && remoteSpeech.grounded) {
    resolvedIntro = remoteSpeech;
  } else try {
    resolvedIntro = await summarizeIntro({
      title: typeof claimed.title === 'string' ? claimed.title : '',
      brandName: typeof claimed.brandName === 'string' ? claimed.brandName : '',
      transcriptSegments: transcription.segments,
      placeholderIntro,
    });
  } catch {
    resolvedIntro = { grounded: false };
  }
  if (!generatedIntroFields(resolvedIntro, placeholderIntro).intro && remoteSpeech) {
    resolvedIntro = remoteSpeech;
  }

  return completePrepared({
    ...jobIdentity(claimed),
    outcome: 'ready',
    asr: 'ready',
    transcriptSegments: transcription.segments,
    ...mediaPayload(probe),
    ...transcoded,
    ...cover,
    ...generatedIntroFields(resolvedIntro, placeholderIntro),
  });
}

module.exports = {
  fitSegmentsToDuration,
  generatedIntroFields,
  runOnce,
};
