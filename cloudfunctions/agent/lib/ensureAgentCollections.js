'use strict';

const AGENT_COLLECTIONS = ['video_doc_threads', 'video_doc_messages', 'agent_runs'];

function isCollectionExistsError(error) {
  const code = error && (error.errCode || error.code);
  if (code === 'DATABASE_COLLECTION_EXIST' || code === -501001) return true;
  const msg = String((error && (error.errMsg || error.message)) || '');
  return (
    /already exists/i.test(msg) ||
    /ResourceExist/i.test(msg) ||
    /duplicate collection/i.test(msg) ||
    msg.indexOf('集合已存在') >= 0
  );
}

async function ensureAgentCollections(db) {
  const created = [];
  const existed = [];
  for (const name of AGENT_COLLECTIONS) {
    try {
      await db.createCollection(name);
      created.push(name);
    } catch (error) {
      if (!isCollectionExistsError(error)) throw error;
      existed.push(name);
    }
  }
  return { created, existed };
}

module.exports = { AGENT_COLLECTIONS, ensureAgentCollections };
