'use strict';

// wx.cloud.uploadFile 会把 timeout 交给 wx.uploadFile。不传时平台默认 60 秒，
// 管理端长视频经常在这一分钟被掐断。
const VIDEO_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

function cloudUploadOptions({ kind, cloudPath, filePath }) {
  const options = { cloudPath, filePath };
  if (kind === 'video') {
    options.timeout = VIDEO_UPLOAD_TIMEOUT_MS;
  }
  return options;
}

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

function posterUrlFromList(videos, videoId) {
  const id = String(videoId || '').trim();
  const found = (videos || []).find((item) => item && item._id === id);
  const url = String((found && found.posterUrl) || '').trim();
  return isHttpPosterUrl(url) ? url : '';
}

function displayedPoster({
  currentCoverFileId,
  currentPosterUrl,
  nextCoverFileId,
  nextPosterUrl,
}) {
  const nextId = String(nextCoverFileId || '').trim();
  const currentId = String(currentCoverFileId || '').trim();
  const incoming = isHttpPosterUrl(nextPosterUrl) ? String(nextPosterUrl).trim() : '';
  if (incoming) {
    return { coverFileId: nextId, posterUrl: incoming, resolve: false };
  }
  if (nextId && nextId === currentId && currentPosterUrl) {
    return { coverFileId: nextId, posterUrl: currentPosterUrl, resolve: false };
  }
  if (!nextId && currentId) {
    return { coverFileId: currentId, posterUrl: String(currentPosterUrl || ''), resolve: false };
  }
  return { coverFileId: nextId, posterUrl: '', resolve: Boolean(nextId) };
}

module.exports = {
  VIDEO_UPLOAD_TIMEOUT_MS,
  cloudUploadOptions,
  withPosterUrl,
  withPosterUrls,
  displayedPoster,
  posterUrlFromList,
};
