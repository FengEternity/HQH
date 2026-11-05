'use strict';

const KEY = 'hqh_search_miss_draft';

function searchMissDraftText(query) {
  const text = String(query || '').trim();
  return text ? `没找到讲解：${text}` : '没找到讲解';
}

function saveSearchMissDraft(query) {
  wx.setStorageSync(KEY, searchMissDraftText(query));
}

function takeSearchMissDraft() {
  const pending = wx.getStorageSync(KEY) || '';
  if (!pending) {
    return '';
  }
  wx.removeStorageSync(KEY);
  return String(pending);
}

module.exports = {
  saveSearchMissDraft,
  searchMissDraftText,
  takeSearchMissDraft,
};
