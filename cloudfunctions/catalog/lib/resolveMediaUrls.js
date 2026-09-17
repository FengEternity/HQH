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

const TEMP_URL_BATCH = 50;

function uniqueCloudIds(ids) {
  const seen = Object.create(null);
  const out = [];
  for (const raw of ids || []) {
    const id = String(raw || '').trim();
    if (id.indexOf('cloud://') !== 0 || seen[id]) {
      continue;
    }
    seen[id] = true;
    out.push(id);
  }
  return out;
}

async function fetchCoverTempUrlMap(coverFileIds, getTempFileURL) {
  const ids = uniqueCloudIds(coverFileIds);
  const map = Object.create(null);
  if (!ids.length || typeof getTempFileURL !== 'function') {
    return map;
  }
  for (let i = 0; i < ids.length; i += TEMP_URL_BATCH) {
    const chunk = ids.slice(i, i + TEMP_URL_BATCH);
    try {
      const res = await getTempFileURL({
        fileList: chunk.map((fileID) => ({ fileID, maxAge: 86400 })),
      });
      for (const row of (res && res.fileList) || []) {
        const url = rowTempUrl(row);
        if (row && row.fileID && url) {
          map[row.fileID] = url;
        }
      }
    } catch (error) {
      // 单批失败不影响其它封面；也不让 listHome 整单失败
    }
  }
  return map;
}

async function attachPosterUrls(videos, getTempFileURL) {
  let map = Object.create(null);
  try {
    map = await fetchCoverTempUrlMap(
      (videos || []).map((video) => video && video.coverFileId),
      getTempFileURL,
    );
  } catch (error) {
    map = Object.create(null);
  }
  return (videos || []).map((video) => {
    if (!video) {
      return video;
    }
    const cover = String(video.coverFileId || '').trim();
    return Object.assign({}, video, { posterUrl: map[cover] || '' });
  });
}

async function resolveMediaUrls(ids, getTempFileURL) {
  const videoFileId = String((ids && ids.videoFileId) || '').trim();
  const coverFileId = String((ids && ids.coverFileId) || '').trim();
  if (!videoFileId) {
    return { videoUrl: '', posterUrl: '' };
  }

  const fileList = [{ fileID: videoFileId, maxAge: 86400 }];
  if (coverFileId && coverFileId !== videoFileId) {
    fileList.push({ fileID: coverFileId, maxAge: 86400 });
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
  attachPosterUrls,
  resolveMediaUrls,
};
