'use strict';

const { normalizeIngest, planAdminSave, planWorkerComplete } = require('./videoIngest');
const { resolveVideoKnowledge } = require('./videoKnowledge');
const { normalizeVideoMedia } = require('./videoMediaMetadata');

function buildUpsertIngestPatch({ prevData, nextVideoFileId, nextIntro, now }) {
  return planAdminSave({
    prevData,
    nextVideoFileId,
    nextIntro,
    now,
  });
}

function applyCompleteToVideo({ prevData, complete, now }) {
  const previous = prevData || {};
  const prevIngest = normalizeIngest(previous.ingest);
  const planned = planWorkerComplete({
    prevIngest,
    prevIntro: typeof previous.intro === 'string' ? previous.intro : '',
    prevIntroSource: prevIngest.introSource,
    complete,
    now,
  });

  const mediaInput = {};
  if (Object.prototype.hasOwnProperty.call(complete, 'durationSec')) {
    mediaInput.durationSec = complete.durationSec;
  }
  if (Object.prototype.hasOwnProperty.call(complete, 'media')) {
    mediaInput.media = complete.media;
  }
  const mediaMeta = normalizeVideoMedia(mediaInput, previous);

  const shouldApplyTranscript =
    complete.outcome === 'ready' && complete.asr === 'ready';
  const knowledge = shouldApplyTranscript
    ? resolveVideoKnowledge({
        event: complete,
        prevData: previous,
        durationSec: mediaMeta.durationSec,
      })
    : resolveVideoKnowledge({
        event: {},
        prevData: previous,
        durationSec: mediaMeta.durationSec,
      });

  const videoFileId =
    typeof complete.transcodedVideoFileId === 'string' && complete.transcodedVideoFileId
      ? complete.transcodedVideoFileId
      : previous.videoFileId || '';
  const ingest = {
    ...planned.ingest,
    videoFileId,
  };

  return {
    ingest,
    intro: planned.intro,
    transcriptSegments: knowledge.transcriptSegments,
    transcript: knowledge.transcript,
    durationSec: mediaMeta.durationSec,
    media: mediaMeta.media,
    coverFileId:
      previous.coverFileId ||
      (typeof complete.coverFileId === 'string' ? complete.coverFileId : ''),
    videoFileId,
  };
}

module.exports = {
  applyCompleteToVideo,
  buildUpsertIngestPatch,
};
