'use strict';

function searchNoticeText(notice, items) {
  const count = Array.isArray(items) ? items.length : 0;
  if (notice === 'library_overflow') {
    return '讲解较多，本次只搜到其中一部分';
  }
  if (notice === 'coverage_incomplete') {
    return '还有讲解不能按描述来找，结果可能不全';
  }
  if (notice === 'semantic_unavailable') {
    return count ? '按描述来找暂时不可用，以下是按名称找到的' : '按描述来找暂时不可用';
  }
  return '';
}

module.exports = {
  searchNoticeText,
};
