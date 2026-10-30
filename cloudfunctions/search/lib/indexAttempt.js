'use strict';

const { EMBEDDING_DIM, EMBEDDING_MODEL } = require('./searchConfig');
const { chunkSourceText, contentHash, fitChunkText } = require('./chunkText');

const RETRYABLE = new Set(['embed_timeout', 'embed_failed']);

function baseRow(video, now, extra) {
  return Object.assign(
    {
      sourceType: 'video',
      sourceId: video._id,
      status: 'failed',
      contentHash: '',
      error: '',
      attempts: 0,
      text: '',
      embedding: [],
      embeddingModel: '',
      updatedAt: now,
    },
    extra,
  );
}

function priorAttempts(existing) {
  return existing ? Number(existing.attempts) || 0 : 0;
}

function isSameReady(existing, startedHash, modelName) {
  return Boolean(
    existing &&
      existing.status === 'ready' &&
      existing.contentHash === startedHash &&
      existing.embeddingModel === modelName &&
      Array.isArray(existing.embedding) &&
      existing.embedding.length === EMBEDDING_DIM,
  );
}

function shouldCommit(startedHash, storedHash, computedHash) {
  if (!startedHash || computedHash !== startedHash) {
    return false;
  }
  if (storedHash && storedHash !== startedHash) {
    return false;
  }
  return true;
}

function planWithoutEmbed({ video, existing, now, model }) {
  const startedHash = contentHash(video);
  const attempts = priorAttempts(existing);
  if (!chunkSourceText(video)) {
    return {
      action: 'upsert',
      startedHash,
      row: baseRow(video, now, {
        status: 'skipped',
        contentHash: startedHash,
        error: 'empty_text',
        attempts,
      }),
    };
  }
  if (isSameReady(existing, startedHash, model || EMBEDDING_MODEL)) {
    return { action: 'skip', startedHash, row: existing };
  }
  return {
    action: 'upsert',
    startedHash,
    row: baseRow(video, now, {
      status: 'stale',
      contentHash: (existing && existing.contentHash) || '',
      attempts,
    }),
  };
}

function normalizeEmbedError(result) {
  const code = result && result.error;
  if (
    code === 'embed_timeout' ||
    code === 'embed_failed' ||
    code === 'bad_dimension' ||
    code === 'input_too_long'
  ) {
    return code;
  }
  return 'embed_failed';
}

async function attemptEmbed({ video, existing, now, embed, maxInputChars, model }) {
  const startedHash = contentHash(video);
  const modelName = model || EMBEDDING_MODEL;
  let attempts = priorAttempts(existing);
  if (!chunkSourceText(video)) {
    return {
      action: 'upsert',
      startedHash,
      row: baseRow(video, now, {
        status: 'skipped',
        contentHash: startedHash,
        error: 'empty_text',
        attempts,
      }),
    };
  }
  if (isSameReady(existing, startedHash, modelName)) {
    return { action: 'skip', startedHash, row: existing };
  }
  const fitted = fitChunkText(video, maxInputChars);
  if (!fitted.ok) {
    return {
      action: 'upsert',
      startedHash,
      row: baseRow(video, now, {
        status: 'failed',
        contentHash: startedHash,
        error: fitted.error === 'empty_text' ? 'empty_text' : 'input_too_long',
        attempts,
      }),
    };
  }
  let lastError = 'embed_failed';
  let embedding = null;
  for (let tryIndex = 0; tryIndex < 3; tryIndex += 1) {
    attempts += 1;
    let result;
    try {
      result = await embed(fitted.text);
    } catch (error) {
      result = { ok: false, error: 'embed_failed' };
    }
    if (
      result &&
      result.ok &&
      Array.isArray(result.embedding) &&
      result.embedding.length === EMBEDDING_DIM
    ) {
      embedding = result.embedding;
      lastError = '';
      break;
    }
    lastError = normalizeEmbedError(result);
    if (!RETRYABLE.has(lastError)) {
      break;
    }
  }
  if (!embedding) {
    return {
      action: 'upsert',
      startedHash,
      row: baseRow(video, now, {
        status: 'failed',
        contentHash: startedHash,
        error: lastError,
        attempts,
      }),
    };
  }
  return {
    action: 'upsert',
    startedHash,
    row: baseRow(video, now, {
      status: 'ready',
      contentHash: startedHash,
      error: '',
      attempts,
      text: fitted.text,
      embedding,
      embeddingModel: modelName,
    }),
  };
}

function markStaleForRewrite(existing, startedHash, now) {
  if (!existing || existing.status !== 'ready' || existing.contentHash === startedHash) {
    return null;
  }
  return {
    sourceType: existing.sourceType || 'video',
    sourceId: existing.sourceId,
    status: 'stale',
    contentHash: existing.contentHash || '',
    error: '',
    attempts: priorAttempts(existing),
    text: '',
    embedding: [],
    embeddingModel: '',
    updatedAt: now,
  };
}

function outcomeKind(planned) {
  if (!planned || planned.action === 'skip' || planned.action === 'abandon') {
    return 'unchanged';
  }
  if (planned.row && planned.row.status === 'ready') {
    return 'success';
  }
  if (planned.row && planned.row.status === 'failed') {
    return 'failed';
  }
  return 'skipped';
}

module.exports = {
  attemptEmbed,
  markStaleForRewrite,
  outcomeKind,
  planWithoutEmbed,
  shouldCommit,
};
