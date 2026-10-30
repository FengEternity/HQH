'use strict';

const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const { runSearch } = require('./lib/searchIndex');
const { attachPosterUrls } = require('./lib/resolvePosterUrls');
const { verifyTicket } = require('./lib/ticket');
const { expandQuery } = require('./lib/keywordSearch');
const { contentHash } = require('./lib/chunkText');
const { attemptEmbed, markStaleForRewrite, shouldCommit, outcomeKind } = require('./lib/indexAttempt');
const { embedChunkText } = require('./lib/embedClient');
const { applyBatch, createTask, nextBatch, taskView } = require('./lib/indexTask');
const { scorePublishedVideos } = require('./lib/vectorRank');
const { COSINE_THRESHOLD, INDEX_BATCH_SIZE, MAX_INPUT_CHARS, VECTOR_CAP } = require('./lib/searchConfig');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

function badInput() {
  const error = new Error('BAD_INPUT');
  error.code = 'BAD_INPUT';
  throw error;
}

function requireAdmin(ticket) {
  const pin = process.env.ADMIN_PIN;
  if (!verifyTicket(pin, ticket)) {
    badInput();
  }
}

function missingDocument(error) {
  const text = String((error && (error.errMsg || error.message)) || '');
  return /not exist|does not exist|cannot find|不存在|DOCUMENT_NOT_FOUND/i.test(text);
}

async function loadPublishedVideos() {
  const res = await db
    .collection('videos')
    .where({ status: 'published' })
    .field({
      title: true,
      intro: true,
      brandId: true,
      brandName: true,
      productId: true,
      modelName: true,
      tags: true,
      coverFileId: true,
      videoFileId: true,
      status: true,
      publishedAt: true,
      searchBlob: true,
      searchAbstract: true,
      contentHash: true,
    })
    .limit(1000)
    .get();
  return res.data || [];
}

async function loadSynonyms() {
  const res = await db.collection('synonyms').limit(200).get();
  return res.data || [];
}

async function readVideo(id) {
  const snap = await db.collection('videos').doc(id).get();
  if (!snap || !snap.data) {
    return null;
  }
  return Object.assign({ _id: id }, snap.data);
}

async function readChunk(id) {
  try {
    const snap = await db.collection('search_chunks').doc(id).get();
    if (!snap || !snap.data) {
      return null;
    }
    return Object.assign({ sourceId: id }, snap.data);
  } catch (error) {
    if (missingDocument(error)) {
      return null;
    }
    throw error;
  }
}

async function writeChunk(row) {
  const data = Object.assign({}, row);
  const id = data.sourceId;
  delete data._id;
  await db.collection('search_chunks').doc(id).set({ data });
}

async function removeChunk(id) {
  if (!id) {
    return;
  }
  try {
    await db.collection('search_chunks').doc(id).remove();
  } catch (error) {
    if (!missingDocument(error)) {
      throw error;
    }
  }
}

async function readTask(taskId) {
  try {
    const snap = await db.collection('search_index_tasks').doc(taskId).get();
    if (!snap || !snap.data) {
      return null;
    }
    return Object.assign({ taskId }, snap.data);
  } catch (error) {
    if (missingDocument(error)) {
      return null;
    }
    throw error;
  }
}

async function saveTask(task) {
  const data = Object.assign({}, task);
  delete data.batchFailed;
  await db.collection('search_index_tasks').doc(task.taskId).set({ data });
}

async function indexOne(videoId) {
  const video = await readVideo(videoId);
  if (!video || video.status !== 'published') {
    await removeChunk(videoId);
    return { id: videoId, kind: 'skipped' };
  }
  let existing = await readChunk(videoId);
  const startedHash = contentHash(video);
  const stale = markStaleForRewrite(existing, startedHash, Date.now());
  if (stale) {
    await writeChunk(stale);
    existing = stale;
  }
  const planned = await attemptEmbed({
    video,
    existing,
    now: Date.now(),
    maxInputChars: MAX_INPUT_CHARS,
    embed: (text) => embedChunkText(text),
  });
  const fresh = await readVideo(videoId);
  const storedHash = (fresh && fresh.contentHash) || '';
  const computedHash = fresh ? contentHash(fresh) : '';
  if (!shouldCommit(planned.startedHash, storedHash, computedHash)) {
    return { id: videoId, kind: 'unchanged' };
  }
  if (planned.action === 'skip') {
    if (!storedHash) {
      await db.collection('videos').doc(videoId).update({
        data: { contentHash: planned.startedHash },
      });
    }
    return { id: videoId, kind: outcomeKind(planned) };
  }
  await writeChunk(planned.row);
  if (!storedHash) {
    await db.collection('videos').doc(videoId).update({
      data: { contentHash: planned.startedHash },
    });
  }
  return {
    id: videoId,
    kind: outcomeKind(planned),
    error: planned.row && planned.row.error,
  };
}

async function handleQuery(event) {
  const scene = event && event.scene;
  if (scene !== 'video' && scene !== 'product') {
    return { ok: false, code: 'BAD_INPUT' };
  }
  if (scene === 'product') {
    return runSearch({ scene, query: event && event.query });
  }
  const query = event && event.query;
  if (!String(query || '').trim()) {
    return runSearch({ scene, query });
  }
  const [videos, synonyms] = await Promise.all([loadPublishedVideos(), loadSynonyms()]);
  const vectorOn = typeof COSINE_THRESHOLD === 'number' && Number.isFinite(COSINE_THRESHOLD);
  const publishedCount = videos.filter((video) => video && video.status === 'published').length;
  let embedError = false;
  let queryEmbedding;
  let chunks = [];
  if (vectorOn && publishedCount > 0 && publishedCount <= VECTOR_CAP) {
    const sentence = expandQuery(query, synonyms).join(' ');
    const embedded = sentence ? await embedChunkText(sentence) : { ok: false, error: 'embed_failed' };
    if (!embedded.ok) {
      embedError = true;
    } else {
      queryEmbedding = embedded.embedding;
      chunks = await loadChunks(videos);
    }
  }
  const result = runSearch({
    scene,
    query,
    videos,
    synonyms,
    chunks,
    queryEmbedding,
    embedError,
    threshold: COSINE_THRESHOLD,
  });
  if (!result.ok || !result.items || !result.items.length) {
    return result;
  }
  result.items = await attachPosterUrls(result.items, (payload) => cloud.getTempFileURL(payload));
  return result;
}

async function handleReindex(event) {
  const videoId = String((event && event.videoId) || '').trim();
  if (!videoId) {
    badInput();
  }
  const outcome = await indexOne(videoId);
  return { ok: true, videoId, status: outcome.kind };
}

async function handleDeleteChunk(event) {
  const videoId = String((event && event.videoId) || '').trim();
  if (!videoId) {
    badInput();
  }
  await removeChunk(videoId);
  return { ok: true, videoId };
}

async function loadChunks(videos) {
  const command = db.command;
  const ids = (videos || []).map((video) => video && video._id).filter(Boolean);
  const rows = [];
  for (let index = 0; index < ids.length; index += 10) {
    const part = ids.slice(index, index + 10);
    const res = await db
      .collection('search_chunks')
      .where({ sourceType: 'video', sourceId: command.in(part) })
      .limit(10)
      .get();
    rows.push.apply(rows, res.data || []);
  }
  return rows;
}

async function listPublishedIds() {
  const res = await db
    .collection('videos')
    .where({ status: 'published' })
    .field({ _id: true })
    .limit(1000)
    .get();
  return (res.data || []).map((row) => row._id).filter(Boolean);
}

async function advanceStoredTask(task) {
  const ids = nextBatch(task, INDEX_BATCH_SIZE);
  const outcomes = [];
  for (const id of ids) {
    outcomes.push(await indexOne(id));
  }
  const next = applyBatch(task, outcomes, Date.now());
  await saveTask(next);
  return taskView(next);
}

async function handleStartTask(event) {
  const taskType = event && event.taskType;
  if (taskType !== 'backfill' && taskType !== 'brandRename' && taskType !== 'rebuild') {
    badInput();
  }
  const provided = Array.isArray(event.videoIds) ? event.videoIds : [];
  const videoIds = provided.length ? provided : await listPublishedIds();
  const task = createTask({
    taskId: crypto.randomBytes(8).toString('hex'),
    taskType,
    videoIds,
    now: Date.now(),
  });
  await saveTask(task);
  if (!task.videoIds.length) {
    return taskView(task);
  }
  return advanceStoredTask(task);
}

async function handleAdvanceTask(event) {
  const taskId = String((event && event.taskId) || '').trim();
  if (!taskId) {
    badInput();
  }
  const task = await readTask(taskId);
  if (!task) {
    badInput();
  }
  if (!task.cursor) {
    return taskView(task);
  }
  return advanceStoredTask(task);
}

async function handleProbe(event) {
  const query = String((event && event.query) || '').trim();
  if (!query) {
    badInput();
  }
  const [videos, synonyms] = await Promise.all([loadPublishedVideos(), loadSynonyms()]);
  const sentence = expandQuery(query, synonyms).join(' ');
  const embedded = sentence ? await embedChunkText(sentence) : { ok: false, error: 'embed_failed' };
  if (!embedded.ok) {
    return { ok: false, code: embedded.error || 'embed_failed' };
  }
  const chunks = await loadChunks(videos);
  const scored = scorePublishedVideos({
    videos,
    chunks,
    queryEmbedding: embedded.embedding,
  });
  return {
    ok: true,
    published: scored.published,
    scored: scored.scored,
    items: scored.items,
  };
}

async function handleOps(event) {
  requireAdmin(event && event.ticket);
  if (event.action === 'probeCosine') {
    return handleProbe(event);
  }
  if (event.action === 'reindexVideo') {
    return handleReindex(event);
  }
  if (event.action === 'deleteChunk') {
    return handleDeleteChunk(event);
  }
  if (event.action === 'startIndexTask') {
    return handleStartTask(event);
  }
  if (event.action === 'advanceIndexTask') {
    return handleAdvanceTask(event);
  }
  badInput();
}

async function handle(event) {
  if (event && event.action) {
    return handleOps(event);
  }
  return handleQuery(event);
}

exports.main = async (event) => {
  try {
    return await handle(event);
  } catch (error) {
    return { ok: false, code: error.code === 'BAD_INPUT' ? 'BAD_INPUT' : 'FAIL' };
  }
};
