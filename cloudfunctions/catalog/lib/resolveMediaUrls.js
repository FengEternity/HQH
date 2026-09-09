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
  resolveMediaUrls,
};
