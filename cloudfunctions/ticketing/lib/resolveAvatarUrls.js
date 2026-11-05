'use strict';

const TEMP_URL_MAX_AGE = 86400;
const TEMP_URL_BATCH = 50;

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

async function attachAvatarUrls(records, getTempFileURL) {
  const list = Array.isArray(records) ? records : [];
  const ids = [];
  const seen = new Set();
  for (const item of list) {
    const id = String((item && item.avatarFileId) || '').trim();
    if (id.indexOf('cloud://') === 0 && !seen.has(id)) {
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
      // 头像换链失败时列表仍可打开，页面退回昵称首字
    }
  }
  return list.map((item) => {
    const id = String((item && item.avatarFileId) || '').trim();
    return Object.assign({}, item, { avatarUrl: (id && urlById[id]) || '' });
  });
}

module.exports = {
  attachAvatarUrls,
};
