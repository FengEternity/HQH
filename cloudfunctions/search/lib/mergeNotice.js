'use strict';

function decideNotice(state) {
  if (!state || !state.publishedCount) {
    return '';
  }
  if (!state.vectorEnabled) {
    return 'semantic_unavailable';
  }
  if (state.embedError || state.overCap || !state.indexed) {
    return 'semantic_unavailable';
  }
  if (state.indexed < state.expected) {
    return 'coverage_incomplete';
  }
  return '';
}

function mergeVideos(keywordVideos, vectorHits) {
  const seen = new Set();
  const ordered = [];
  for (const video of keywordVideos || []) {
    const id = String(video && video._id);
    if (!video || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ordered.push(video);
  }
  for (const hit of vectorHits || []) {
    const video = hit && hit.video;
    const id = String(video && video._id);
    if (!video || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ordered.push(video);
  }
  return ordered;
}

module.exports = {
  decideNotice,
  mergeVideos,
};
