'use strict';

// 云开发 uploadFile 没有 timeout 参数。把 timeout 传进去时，返回值可能不再是会结束的 Promise，
// 页面上的「上传中」就关不掉。时长上限放在 app.json 的 networkTimeout.uploadFile。
const VIDEO_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

function cloudUploadOptions({ cloudPath, filePath }) {
  return { cloudPath, filePath };
}

function uploadFailure(err, fallback) {
  const raw = err && (err.errMsg || err.message);
  const text = String(raw || '').replace(/^cloud\.uploadFile:fail\s*/i, '').trim();
  if (!text || text.length > 14) {
    return new Error(fallback);
  }
  return new Error(text);
}

function beginCloudUpload(uploadFile, options, hooks) {
  const timeoutMs = hooks && hooks.timeoutMs;
  const setTimer = (hooks && hooks.setTimer) || setTimeout;
  const clearTimerFn = (hooks && hooks.clearTimer) || clearTimeout;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let task;
    const finish = (error, result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer != null) {
        clearTimerFn(timer);
      }
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    };
    try {
      task = uploadFile(Object.assign({}, options, {
        success: (res) => finish(null, res),
        fail: (err) => finish(uploadFailure(err, '上传失败')),
      }));
    } catch (err) {
      finish(uploadFailure(err, '上传失败'));
      return;
    }
    if (!settled && timeoutMs > 0) {
      timer = setTimer(() => {
        if (task && typeof task.abort === 'function') {
          task.abort();
        }
        finish(new Error('上传超时'));
      }, timeoutMs);
    }
    if (task && typeof task.then === 'function') {
      task.then(
        (res) => finish(null, res),
        (err) => finish(uploadFailure(err, '上传失败')),
      );
    }
    if (task && typeof task.onProgressUpdate === 'function' && hooks && hooks.onProgress) {
      task.onProgressUpdate(hooks.onProgress);
    }
  });
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
  beginCloudUpload,
  cloudUploadOptions,
  withPosterUrl,
  withPosterUrls,
  displayedPoster,
  posterUrlFromList,
};
