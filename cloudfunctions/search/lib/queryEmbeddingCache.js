'use strict';

const crypto = require('crypto');
const { EMBEDDING_DIM, EMBEDDING_MODEL } = require('./searchConfig');

const QUERY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function queryCacheId(model, sentence) {
  return crypto.createHash('sha256').update(String(model || '') + '\n' + String(sentence || '')).digest('hex');
}

function freshEmbedding(row, now, model) {
  if (!row || row.embeddingModel !== (model || EMBEDDING_MODEL)) return null;
  if (now - Number(row.updatedAt) >= QUERY_CACHE_TTL_MS) return null;
  if (!Array.isArray(row.embedding) || row.embedding.length !== EMBEDDING_DIM) return null;
  return row.embedding;
}

async function readQueryEmbedding(db, id, now, model) {
  try {
    const snap = await db.collection('search_query_cache').doc(id).get();
    return freshEmbedding(snap && snap.data, now, model);
  } catch (error) {
    return null;
  }
}

async function writeQueryEmbedding(db, id, embedding, now, model) {
  try {
    await db.collection('search_query_cache').doc(id).set({
      data: {
        embedding,
        embeddingModel: model || EMBEDDING_MODEL,
        updatedAt: now,
      },
    });
  } catch (error) {
    return;
  }
}

const EMBED_RETRYABLE = new Set(['embed_timeout', 'embed_failed']);

async function embedOnce(embed, sentence) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const embedded = await embed(sentence);
    if (embedded && embedded.ok) {
      return embedded;
    }
    const error = (embedded && embedded.error) || 'embed_failed';
    if (!EMBED_RETRYABLE.has(error) || attempt === 1) {
      return { ok: false, error };
    }
  }
  return { ok: false, error: 'embed_failed' };
}

async function resolveQueryEmbedding({ db, sentence, embed, now, model }) {
  const modelName = model || EMBEDDING_MODEL;
  const id = queryCacheId(modelName, sentence);
  const cached = await readQueryEmbedding(db, id, now, modelName);
  if (cached) return { ok: true, embedding: cached, cached: true };
  const embedded = await embedOnce(embed, sentence);
  if (!embedded || !embedded.ok) return { ok: false, error: (embedded && embedded.error) || 'embed_failed' };
  if (!freshEmbedding({ embedding: embedded.embedding, embeddingModel: modelName, updatedAt: now }, now, modelName)) {
    return { ok: false, error: 'bad_dimension' };
  }
  await writeQueryEmbedding(db, id, embedded.embedding, now, modelName);
  return { ok: true, embedding: embedded.embedding, cached: false };
}

module.exports = {
  QUERY_CACHE_TTL_MS,
  freshEmbedding,
  queryCacheId,
  resolveQueryEmbedding,
};
