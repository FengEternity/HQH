'use strict';

const { createServiceProof } = require('./ai-runtime');

const PURPOSE = 'video-ingest:write-intro';
const INTRO_TRANSCRIPT_LIMIT = 4000;

function clipTranscript(transcript) {
  const text = String(transcript || '');
  const chars = [...text];
  if (chars.length <= INTRO_TRANSCRIPT_LIMIT) return text;
  return chars.slice(0, INTRO_TRANSCRIPT_LIMIT).join('');
}

async function requestIntro({ app, pin, title, brandName, transcript, terms, now }) {
  if (!String(pin || '').trim()) {
    const error = new Error('NOT_CONFIGURED');
    error.code = 'NOT_CONFIGURED';
    throw error;
  }
  const response = await app.callFunction({
    name: 'agent',
    data: {
      action: 'writeVideoIntro',
      proof: createServiceProof(pin, PURPOSE, now),
      title: title || '',
      brandName: brandName || '',
      transcript: clipTranscript(transcript),
      terms: Array.isArray(terms) ? terms : [],
    },
  });
  const result = response && (response.result !== undefined ? response.result : response);
  if (!result || result.ok !== true || typeof result.intro !== 'string' || !result.intro.trim()) {
    const error = new Error('简介生成失败');
    error.code = result && typeof result.code === 'string' ? result.code : 'AGENT_CALL_FAILED';
    throw error;
  }
  return result.intro;
}

module.exports = { PURPOSE, INTRO_TRANSCRIPT_LIMIT, requestIntro };
