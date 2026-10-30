'use strict';

function searchNoticeText(notice, items) {
  const count = Array.isArray(items) ? items.length : 0;
  if (notice === 'coverage_incomplete') {
    return '语义检索未覆盖全部讲解，结果可能不全';
  }
  if (notice === 'semantic_unavailable') {
    return count ? '语义检索暂不可用，以下为关键词结果' : '语义检索暂不可用';
  }
  return '';
}

module.exports = {
  searchNoticeText,
};
