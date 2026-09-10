'use strict';

function isHttpPosterUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function withPosterUrl(video) {
  if (!video) {
    return video;
  }
  const raw = String(video.posterUrl || '').trim();
  return Object.assign({}, video, { posterUrl: isHttpPosterUrl(raw) ? raw : '' });
}

function withPosterUrls(list) {
  return (list || []).map(withPosterUrl);
}

function planVideoCoverUpload(input) {
  const coverFileId = String((input && input.coverFileId) || '').trim();
  const thumbTempFilePath = String((input && input.thumbTempFilePath) || '').trim();
  if (coverFileId) {
    return { action: 'keep' };
  }
  if (!thumbTempFilePath) {
    return { action: 'missing_thumb' };
  }
  return { action: 'upload_thumb', path: thumbTempFilePath };
}

module.exports = {
  withPosterUrl,
  withPosterUrls,
  planVideoCoverUpload,
};
