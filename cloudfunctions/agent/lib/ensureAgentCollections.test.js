'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { AGENT_COLLECTIONS, ensureAgentCollections } = require('./ensureAgentCollections');

describe('ensureAgentCollections', () => {
  it('creates the video doc message collections and the control collection', async () => {
    const calls = [];
    const db = {
      createCollection: async (name) => {
        calls.push(name);
        if (name === 'agent_runs') {
          const error = new Error('collection already exists');
          error.errCode = 'DATABASE_COLLECTION_EXIST';
          throw error;
        }
      },
    };
    const result = await ensureAgentCollections(db);
    assert.deepEqual(calls, AGENT_COLLECTIONS);
    assert.deepEqual(result.created, ['video_doc_threads', 'video_doc_messages']);
    assert.deepEqual(result.existed, ['agent_runs']);
  });

  it('treats an existing collection as success', async () => {
    const db = {
      createCollection: async () => {
        const error = new Error('ResourceExist.Collection');
        error.errCode = -501001;
        throw error;
      },
    };
    const result = await ensureAgentCollections(db);
    assert.deepEqual(result.created, []);
    assert.deepEqual(result.existed, AGENT_COLLECTIONS);
  });
});
