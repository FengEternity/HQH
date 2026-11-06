'use strict';

const { runTurn } = require('./runTurn');

const TRANSCRIPT_LIMIT = 2000;
const WINDOW_BEFORE_SEC = 30;
const WINDOW_AFTER_SEC = 90;

function cleanText(value) {
  const text = String(value || '').trim();
  return text || '';
}

function segmentText(segment) {
  return cleanText(segment && segment.text);
}

function clipTranscript(video, currentTimeSec) {
  const segments = Array.isArray(video && video.transcriptSegments) ? video.transcriptSegments : [];
  const usable = segments.filter((segment) => segmentText(segment));
  const hasTime = currentTimeSec !== undefined && currentTimeSec !== null && currentTimeSec !== '';
  let source = '';
  let omitted = false;
  if (usable.length && hasTime) {
    const sec = Number(currentTimeSec);
    const windowStart = sec - WINDOW_BEFORE_SEC;
    const windowEnd = sec + WINDOW_AFTER_SEC;
    const picked = usable.filter((segment) => {
      const start = Number(segment.startSec) || 0;
      const end = Number(segment.endSec) || 0;
      return end >= windowStart && start <= windowEnd;
    });
    omitted = picked.length !== usable.length;
    source = picked.map(segmentText).join('\n');
    if (!source) source = cleanText(video.transcript);
  } else if (usable.length) {
    source = usable.map(segmentText).join('\n');
  } else {
    source = cleanText(video && video.transcript);
  }
  if (!source) return { transcript: '', transcriptTruncated: false };
  if (source.length <= TRANSCRIPT_LIMIT) {
    return { transcript: source, transcriptTruncated: omitted };
  }
  return { transcript: source.slice(0, TRANSCRIPT_LIMIT), transcriptTruncated: true };
}

function projectVideo(video, products, currentTimeSec) {
  const published = (products || []).filter((item) => item && item.status === 'published');
  const projection = {
    title: cleanText(video.title),
    intro: cleanText(video.intro),
    tags: Array.isArray(video.tags) ? video.tags.map((tag) => String(tag)) : [],
    brandName: cleanText(video.brandName),
    modelName: cleanText(video.modelName),
    products: published.map((item) => ({
      id: String(item.id || item._id || ''),
      name: cleanText(item.name),
      priceFen: Number(item.priceFen) || 0,
    })),
  };
  const clipped = clipTranscript(video, currentTimeSec);
  if (clipped.transcript) {
    projection.transcript = clipped.transcript;
    if (clipped.transcriptTruncated) projection.transcriptTruncated = true;
  }
  if (currentTimeSec !== undefined && currentTimeSec !== null && currentTimeSec !== '') {
    const sec = Number(currentTimeSec);
    if (!Number.isInteger(sec) || sec < 0) {
      const error = new Error('BAD_INPUT');
      error.code = 'BAD_INPUT';
      throw error;
    }
    projection.playbackLabel = '约第 ' + sec + ' 秒';
  }
  return projection;
}

async function runVideoDocTurn(input) {
  const videoId = cleanText(input && input.videoId);
  if (!videoId) {
    return { ok: false, code: 'BAD_INPUT', message: '请从讲解页提问', spans: [] };
  }
  let projection;
  try {
    const video = await input.loadVideo(videoId);
    if (!video || video.status !== 'published') {
      return { ok: false, code: 'NOT_FOUND', message: '这条讲解暂时不能提问', spans: [] };
    }
    const products = await input.loadLinkedProducts(videoId);
    projection = projectVideo(video, products, input.currentTimeSec);
  } catch (error) {
    if (error && error.code === 'BAD_INPUT') {
      return { ok: false, code: 'BAD_INPUT', message: '播放位置不正确', spans: [] };
    }
    throw error;
  }

  const lookup = async () => {
    const doc = Object.assign({}, projection);
    delete doc.playbackLabel;
    return doc;
  };

  return runTurn({
    profileId: 'video_doc',
    actor: input.actor,
    input: { text: input.text, currentTimeSec: input.currentTimeSec },
    requestId: input.requestId,
    executor: ({ tools, profileId, profileVersion }) =>
      input.executor({
        tools: Object.assign({}, tools, { lookup_current_video_doc: lookup }),
        projection,
        text: input.text,
        profileId,
        profileVersion,
      }),
  });
}

module.exports = { runVideoDocTurn, projectVideo, TRANSCRIPT_LIMIT };
