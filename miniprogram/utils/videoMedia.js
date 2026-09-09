'use strict';

function withPosterUrl(video) {
  if (!video) {
    return video;
  }
  const posterUrl = String(video.posterUrl || video.coverFileId || '').trim();
  return Object.assign({}, video, { posterUrl });
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
