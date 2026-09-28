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
  VIDEO_UPLOAD_TIMEOUT_MS,
  cloudUploadOptions,
  withPosterUrl,
  withPosterUrls,
  planVideoCoverUpload,
};
