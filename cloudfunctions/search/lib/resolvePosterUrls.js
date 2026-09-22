'use strict';

function rowTempUrl(row) {
  if (!row || row.status !== 0) {
    return '';
  }
  return String(row.tempFileURL || '').trim();
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

async function attachPosterUrls(items, getTempFileURL) {
  const ids = uniqueCloudIds((items || []).map((item) => item && item.coverFileId));
  const map = Object.create(null);
  if (ids.length && typeof getTempFileURL === 'function') {
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
        // 单批失败不影响条目列表
      }
    }
  }
  return (items || []).map((item) => {
    if (!item) {
      return item;
    }
    const cover = String(item.coverFileId || '').trim();
    return Object.assign({}, item, { posterUrl: map[cover] || '' });
  });
}

module.exports = {
  attachPosterUrls,
};
