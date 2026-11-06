'use strict';

function decideNotice(state) {
  if (!state || !state.publishedCount) {
    return '';
  }
  if (state.libraryTruncated) {
    return 'library_overflow';
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

function mergeThreeLanes(keywordVideos, agentVideos, ragHits) {
  const seen = new Set();
  const ordered = [];
  const push = (video) => {
    const id = String(video && video._id);
    if (!video || seen.has(id)) {
      return;
    }
    seen.add(id);
    ordered.push(video);
  };
  for (const video of keywordVideos || []) {
    push(video);
  }
  for (const video of agentVideos || []) {
    push(video);
  }
  for (const hit of ragHits || []) {
    push(hit && hit.video);
  }
  return ordered;
}

function decideThreeLaneNotice(state) {
  if (state && state.agentFailed) {
    return 'agent_unavailable';
  }
  if (state && (state.embedError || state.overCap || (state.expected > 0 && !state.indexed))) {
    return 'semantic_unavailable';
  }
  if (state && state.expected > 0 && state.indexed < state.expected) {
    return 'coverage_incomplete';
  }
  return '';
}

module.exports = {
  decideNotice,
  decideThreeLaneNotice,
  mergeThreeLanes,
  mergeVideos,
};
