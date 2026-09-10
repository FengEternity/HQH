'use strict';

function rowTempUrl(row) {
  if (!row || row.status !== 0) {
    return '';
  }
  return String(row.tempFileURL || '').trim();
}

function tempUrlFromFileList(fileList, fileId, preferredIndex) {
  const id = String(fileId || '').trim();
  const rows = fileList || [];
  if (!id) {
    return '';
  }
  const matched = rows.find((item) => item && item.fileID === id);
  const fromMatch = rowTempUrl(matched);
  if (fromMatch) {
    return fromMatch;
  }
  if (preferredIndex == null || preferredIndex < 0) {
    return '';
  }
  return rowTempUrl(rows[preferredIndex]);
}

function describeFailRow(row) {
  if (!row) {
    return '无换链结果';
  }
  const status = row.status == null ? '?' : String(row.status);
  const errMsg = String(row.errMsg || '').trim();
  return errMsg ? `status=${status} ${errMsg}` : `status=${status}`;
}

const TEMP_URL_MAX_AGE = 86400;
const TEMP_URL_BATCH = 50;

async function attachPosterUrls(videos, getTempFileURL) {
  const list = Array.isArray(videos) ? videos : [];
  const ids = [];
  const seen = new Set();
  for (const video of list) {
    const id = String((video && video.coverFileId) || '').trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  const urlById = Object.create(null);
  if (ids.length && typeof getTempFileURL === 'function') {
    try {
      for (let i = 0; i < ids.length; i += TEMP_URL_BATCH) {
        const chunk = ids.slice(i, i + TEMP_URL_BATCH);
        const res = await getTempFileURL({
          fileList: chunk.map((fileID) => ({ fileID, maxAge: TEMP_URL_MAX_AGE })),
        });
        const rows = (res && res.fileList) || [];
        chunk.forEach((fileID, index) => {
          const url = tempUrlFromFileList(rows, fileID, index);
          if (url) {
            urlById[fileID] = url;
          }
        });
      }
    } catch (_err) {
      // 列表页不能因封面换链失败整页挂掉
    }
  }
  return list.map((video) => {
    const id = String((video && video.coverFileId) || '').trim();
    return Object.assign({}, video, { posterUrl: (id && urlById[id]) || '' });
  });
}

async function resolveMediaUrls(ids, getTempFileURL) {
  const videoFileId = String((ids && ids.videoFileId) || '').trim();
  const coverFileId = String((ids && ids.coverFileId) || '').trim();
  if (!videoFileId) {
    return { videoUrl: '', posterUrl: '' };
  }

  const fileList = [{ fileID: videoFileId, maxAge: TEMP_URL_MAX_AGE }];
  if (coverFileId && coverFileId !== videoFileId) {
    fileList.push({ fileID: coverFileId, maxAge: TEMP_URL_MAX_AGE });
  }

  const res = await getTempFileURL({ fileList });
  const rows = (res && res.fileList) || [];
  const videoUrl = tempUrlFromFileList(rows, videoFileId, 0);
  if (!videoUrl) {
    const err = new Error(`视频文件无法访问（${describeFailRow(rows[0])}）`);
    err.code = 'MEDIA_URL_FAIL';
    throw err;
  }
  const posterUrl = coverFileId ? tempUrlFromFileList(rows, coverFileId, 1) : '';
  return { videoUrl, posterUrl };
}

module.exports = {
  tempUrlFromFileList,
  resolveMediaUrls,
  attachPosterUrls,
};
