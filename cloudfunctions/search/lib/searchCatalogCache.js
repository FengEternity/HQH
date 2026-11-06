'use strict';

const CATALOG_TTL_MS = 60 * 1000;

function publishedFingerprint(videos) {
  return (videos || [])
    .filter((video) => video && video.status === 'published' && video._id)
    .map((video) => String(video._id) + ':' + String(video.contentHash || ''))
    .sort()
    .join('\n');
}

function createCatalogCache({ ttlMs = CATALOG_TTL_MS } = {}) {
  let entry = null;
  return {
    read(videos, now) {
      const fingerprint = publishedFingerprint(videos);
      if (!entry || entry.fingerprint !== fingerprint) {
        return null;
      }
      if (Number(now) - entry.storedAt >= ttlMs) {
        return null;
      }
      return entry.chunks;
    },
    write(videos, chunks, now) {
      entry = {
        fingerprint: publishedFingerprint(videos),
        chunks: chunks || [],
        storedAt: Number(now) || 0,
      };
    },
  };
}

const shared = createCatalogCache();

module.exports = {
  CATALOG_TTL_MS,
  createCatalogCache,
  publishedFingerprint,
  readCatalogChunks: (videos, now) => shared.read(videos, now),
  writeCatalogChunks: (videos, chunks, now) => shared.write(videos, chunks, now),
};
