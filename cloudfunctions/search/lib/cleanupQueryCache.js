'use strict';

const { QUERY_CACHE_TTL_MS } = require('./queryEmbeddingCache');
const { loadAllPages } = require('./pagedRead');

// 缓存按查询文本哈希存向量，超过 TTL 的行永远读不到；留两倍 TTL 的余量再清，避免边界抖动误删
const QUERY_CACHE_RETIRE_MS = 2 * QUERY_CACHE_TTL_MS;

async function cleanupQueryCache({ db, now }) {
  const cutoff = now - QUERY_CACHE_RETIRE_MS;
  const { rows } = await loadAllPages((skip, pageSize) =>
    db.collection('search_query_cache').skip(skip).limit(pageSize).get().then((res) => res.data || []));
  let removed = 0;
  for (const row of rows) {
    if (Number(row.updatedAt) >= cutoff) {
      continue;
    }
    await db.collection('search_query_cache').doc(row._id).remove();
    removed += 1;
  }
  return { ok: true, removed, scanned: rows.length };
}

module.exports = { QUERY_CACHE_RETIRE_MS, cleanupQueryCache };
