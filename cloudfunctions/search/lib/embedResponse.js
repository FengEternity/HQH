'use strict';

const { EMBEDDING_DIM } = require('./searchConfig');

function parseEmbeddingResponse(body) {
  const row = body && Array.isArray(body.data) ? body.data[0] : null;
  const vector = row && row.embedding;
  if (!Array.isArray(vector)) {
    return { ok: false, error: 'embed_failed' };
  }
  if (vector.length !== EMBEDDING_DIM) {
    return { ok: false, error: 'bad_dimension' };
  }
  return { ok: true, embedding: vector };
}

module.exports = {
  parseEmbeddingResponse,
};
