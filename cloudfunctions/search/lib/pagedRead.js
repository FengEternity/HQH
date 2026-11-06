'use strict';

async function loadAllPages(fetchPage, { pageSize = 1000, hardCap = 5000 } = {}) {
  const rows = [];
  for (let skip = 0; skip < hardCap; skip += pageSize) {
    const page = (await fetchPage(skip, pageSize)) || [];
    rows.push.apply(rows, page);
    if (page.length < pageSize) {
      return { rows, truncated: false };
    }
  }
  return { rows, truncated: true };
}

module.exports = { loadAllPages };
