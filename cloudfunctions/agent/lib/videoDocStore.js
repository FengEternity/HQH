'use strict';

const crypto = require('node:crypto');

const THREADS = 'video_doc_threads';
const MESSAGES = 'video_doc_messages';
const RUNS = 'agent_runs';

function scopeHash(openid, videoId) {
  return crypto.createHash('sha256').update(String(openid) + '\n' + String(videoId)).digest('hex');
}

async function findThread(db, openid, videoId) {
  const res = await db.collection(THREADS).where({ openid, videoId }).get();
  return (res.data && res.data[0]) || null;
}

async function ensureThread(db, { openid, videoId, now }) {
  const existing = await findThread(db, openid, videoId);
  if (existing) return existing;
  const data = {
    openid,
    videoId,
    scopeHash: scopeHash(openid, videoId),
    createdAt: now,
    updatedAt: now,
  };
  const added = await db.collection(THREADS).add({ data });
  return Object.assign({ _id: added._id }, data);
}

async function listMessages(db, threadId) {
  const res = await db.collection(MESSAGES).where({ threadId }).get();
  return (res.data || []).slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

async function appendMessage(db, data) {
  const added = await db.collection(MESSAGES).add({ data });
  return Object.assign({ _id: added._id }, data);
}

async function findRun(db, scopeHashValue, requestId) {
  const res = await db.collection(RUNS).where({ scopeHash: scopeHashValue, requestId }).get();
  return (res.data && res.data[0]) || null;
}

async function listRuns(db, scopeHashValue) {
  const query = db.collection(RUNS).where({ scopeHash: scopeHashValue });
  const limited = typeof query.limit === 'function' ? query.limit(100) : query;
  const res = await limited.get();
  return res.data || [];
}

async function addRun(db, data) {
  const added = await db.collection(RUNS).add({ data });
  return Object.assign({ _id: added._id }, data);
}

async function updateRun(db, id, data) {
  await db.collection(RUNS).doc(id).update({ data });
}

function publicMessage(row) {
  return {
    id: row._id,
    role: row.role,
    text: row.text,
    meta: row.meta || null,
    createdAt: row.createdAt,
  };
}

module.exports = {
  THREADS,
  MESSAGES,
  RUNS,
  scopeHash,
  findThread,
  ensureThread,
  listMessages,
  appendMessage,
  findRun,
  listRuns,
  addRun,
  updateRun,
  publicMessage,
};
