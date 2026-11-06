'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EMBEDDING_DIM, EMBEDDING_MODEL } = require('./searchConfig');
const { auditChunks } = require('./vectorRank');

function readyChunk(sourceId, contentHash) {
  const embedding = new Array(EMBEDDING_DIM).fill(0);
  embedding[0] = 1;
  return { sourceId, status: 'ready', contentHash, embeddingModel: EMBEDDING_MODEL, embedding };
}

describe('auditChunks', () => {
  it('splits published videos into missing and stale', () => {
    const videos = [
      { _id: 'ok', status: 'published', contentHash: 'h1' },
      { _id: 'gone', status: 'published', contentHash: 'h2' },
      { _id: 'old', status: 'published', contentHash: 'h3' },
      { _id: 'draft', status: 'draft', contentHash: 'h4' },
    ];
    const chunks = [readyChunk('ok', 'h1'), readyChunk('old', 'h0')];
    const report = auditChunks(videos, chunks);
    assert.deepEqual(report.missing, ['gone']);
    assert.deepEqual(report.stale, ['old']);
  });
});
