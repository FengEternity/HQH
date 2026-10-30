'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EMBEDDING_MODEL, MAX_INPUT_CHARS } = require('./searchConfig');
const { contentHash, fitChunkText } = require('./chunkText');
const { parseEmbeddingResponse } = require('./embedResponse');
const { scorePublishedVideos, selectVectorHits } = require('./vectorRank');
const { runSearch } = require('./searchIndex');
const { attemptEmbed, markStaleForRewrite, planWithoutEmbed, shouldCommit } = require('./indexAttempt');
const { applyBatch, createTask, nextBatch } = require('./indexTask');

function axis(index) {
  const values = new Array(1024).fill(0);
  values[index] = 1;
  return values;
}

function video(overrides) {
  return Object.assign(
    {
      _id: 'v1',
      status: 'published',
      title: '别的标题',
      intro: '',
      brandName: '南方',
      modelName: '',
      tags: [],
      searchBlob: '别的标题 南方',
      contentHash: 'hash-1',
      publishedAt: 1,
    },
    overrides || {},
  );
}

function readyChunk(sourceId, hash, vectorIndex) {
  return {
    sourceId,
    status: 'ready',
    contentHash: hash,
    embeddingModel: EMBEDDING_MODEL,
    embedding: axis(vectorIndex),
  };
}

describe('chunk text', () => {
  it('hashes the full source and only shortens the transcript tail', () => {
    const fields = {
      title: '主机架设',
      intro: '怎么架设',
      tags: ['对中'],
      brandName: '中海达',
      modelName: 'iRTK5',
      transcript: '先整平再对中，然后讲很后面的步骤',
    };
    const fitted = fitChunkText(fields, 27);
    assert.equal(fitted.ok, true);
    assert.equal(fitted.text.startsWith('主机架设\n怎么架设\n对中\n中海达\niRTK5\n'), true);
    assert.equal(fitted.text.includes('很后面的步骤'), false);
    assert.equal(contentHash(fields), contentHash(fields));
    assert.notEqual(
      contentHash(fields),
      contentHash(Object.assign({}, fields, { transcript: '只改口播' })),
    );
  });

  it('fails instead of dropping the title when the head alone is too long', () => {
    const fitted = fitChunkText({ title: '主机架设讲解' }, 4);
    assert.deepEqual(fitted, { ok: false, error: 'input_too_long' });
  });
});

describe('embed response', () => {
  it('accepts a 1024-d vector and rejects a wrong length', () => {
    assert.equal(parseEmbeddingResponse({ data: [{ embedding: axis(0) }] }).ok, true);
    assert.equal(
      parseEmbeddingResponse({ data: [{ embedding: [1, 2, 3] }] }).error,
      'bad_dimension',
    );
    assert.equal(parseEmbeddingResponse({}).error, 'embed_failed');
  });
});

describe('vector merge', () => {
  it('keeps keyword order, appends at most 8 hits at or above the threshold, and ignores a stale hash', () => {
    const keyword = video({
      _id: 'keyword',
      title: '对中讲解',
      searchBlob: '对中讲解',
      contentHash: 'keyword-hash',
      publishedAt: 1,
    });
    const vectorOnly = [];
    for (let index = 0; index < 9; index += 1) {
      vectorOnly.push(
        video({
          _id: `vec-${index}`,
          searchBlob: '无关',
          contentHash: `hash-${index}`,
          publishedAt: index,
        }),
      );
    }
    const stale = video({
      _id: 'stale',
      searchBlob: '无关',
      contentHash: 'new-hash',
      publishedAt: 50,
    });
    const chunks = [
      readyChunk('keyword', 'keyword-hash', 0),
      readyChunk('stale', 'old-hash', 0),
    ].concat(vectorOnly.map((item, index) => readyChunk(item._id, item.contentHash, index === 8 ? 3 : 0)));
    const ranked = selectVectorHits({
      videos: [keyword, stale].concat(vectorOnly),
      chunks,
      queryEmbedding: axis(0),
      threshold: 0.5,
    });
    assert.equal(ranked.hits.length, 8);
    assert.equal(ranked.hits.some((hit) => hit.video._id === 'stale'), false);
    assert.equal(ranked.hits.some((hit) => hit.video._id === 'vec-8'), false);
    const res = runSearch({
      scene: 'video',
      query: '对中',
      videos: [keyword, stale].concat(vectorOnly),
      synonyms: [],
      chunks,
      queryEmbedding: axis(0),
      threshold: 0.5,
    });
    assert.equal(res.items[0].id, 'keyword');
    assert.equal(res.items.filter((item) => item.id === 'keyword').length, 1);
    assert.equal(res.items.some((item) => item.id === 'stale'), false);
    assert.equal(res.items.length, 8);
    assert.equal(res.notice, 'coverage_incomplete');
    assert.equal(res.items[0].score, undefined);
  });

  it('does not append the nearest video when nothing reaches the threshold', () => {
    const item = video({ contentHash: 'hash-1', searchBlob: '无关' });
    const res = runSearch({
      scene: 'video',
      query: '怎么架设',
      videos: [item],
      chunks: [readyChunk('v1', 'hash-1', 1)],
      queryEmbedding: axis(0),
      threshold: 0.5,
    });
    assert.deepEqual(res.items, []);
    assert.equal(res.notice, undefined);
  });

  it('reports semantic_unavailable when embed fails or the library is over 500', () => {
    const item = video();
    const failed = runSearch({
      scene: 'video',
      query: '怎么架设',
      videos: [item],
      embedError: true,
      threshold: 0.5,
    });
    assert.equal(failed.notice, 'semantic_unavailable');
    const many = [];
    for (let index = 0; index < 501; index += 1) {
      many.push(video({ _id: `id-${index}`, searchBlob: '无关', contentHash: `h-${index}` }));
    }
    const capped = runSearch({
      scene: 'video',
      query: '怎么架设',
      videos: many,
      chunks: [readyChunk('id-0', 'h-0', 0)],
      queryEmbedding: axis(0),
      threshold: 0.2,
    });
    assert.equal(capped.notice, 'semantic_unavailable');
    assert.deepEqual(capped.items, []);
  });
});

describe('index attempt', () => {
  it('does not embed again when the ready hash and model are unchanged', async () => {
    let calls = 0;
    const existing = readyChunk('v1', contentHash({ title: '主机' }), 0);
    existing.attempts = 4;
    const planned = await attemptEmbed({
      video: { _id: 'v1', title: '主机', status: 'published' },
      existing,
      now: 10,
      maxInputChars: 100,
      embed: async () => {
        calls += 1;
        return { ok: true, embedding: axis(0) };
      },
    });
    assert.equal(planned.action, 'skip');
    assert.equal(calls, 0);
    assert.equal(existing.attempts, 4);
  });

  it('retries timeout twice more, and does not retry a bad dimension or an overlong head', async () => {
    let timeouts = 0;
    const timed = await attemptEmbed({
      video: { _id: 'v1', title: '主机', transcript: '口播', status: 'published' },
      existing: null,
      now: 10,
      maxInputChars: 100,
      embed: async () => {
        timeouts += 1;
        return { ok: false, error: 'embed_timeout' };
      },
    });
    assert.equal(timeouts, 3);
    assert.equal(timed.row.status, 'failed');
    assert.equal(timed.row.error, 'embed_timeout');
    assert.equal(timed.row.attempts, 3);
    assert.deepEqual(timed.row.embedding, []);

    let dimensions = 0;
    const bad = await attemptEmbed({
      video: { _id: 'v1', title: '主机', status: 'published' },
      existing: { attempts: 1 },
      now: 10,
      maxInputChars: 100,
      embed: async () => {
        dimensions += 1;
        return { ok: false, error: 'bad_dimension' };
      },
    });
    assert.equal(dimensions, 1);
    assert.equal(bad.row.attempts, 2);
    assert.equal(bad.row.error, 'bad_dimension');

    let longs = 0;
    const overlong = await attemptEmbed({
      video: { _id: 'v1', title: '主机架设讲解', status: 'published' },
      existing: { attempts: 2 },
      now: 10,
      maxInputChars: 2,
      embed: async () => {
        longs += 1;
        return { ok: true, embedding: axis(0) };
      },
    });
    assert.equal(longs, 0);
    assert.equal(overlong.row.error, 'input_too_long');
    assert.equal(overlong.row.attempts, 2);
  });

  it('skips empty text and refuses to commit an older embed over a newer hash', async () => {
    const skipped = await attemptEmbed({
      video: { _id: 'v1', title: '  ', status: 'published' },
      existing: null,
      now: 10,
      maxInputChars: 20,
      embed: async () => ({ ok: true, embedding: axis(0) }),
    });
    assert.equal(skipped.row.status, 'skipped');
    assert.equal(skipped.row.error, 'empty_text');
    assert.equal(skipped.row.attempts, 0);
    const fields = { title: '新简介' };
    assert.equal(shouldCommit(contentHash(fields), contentHash({ title: '旧简介' }), contentHash(fields)), false);
    assert.equal(shouldCommit(contentHash(fields), '', contentHash(fields)), true);
  });

  it('embeds at most 2000 characters and keeps the title', async () => {
    assert.equal(MAX_INPUT_CHARS, 2000);
    const transcript = '口'.repeat(3000);
    let sent = '';
    const planned = await attemptEmbed({
      video: { _id: 'v1', title: '主机架设', transcript, status: 'published' },
      existing: null,
      now: 10,
      maxInputChars: MAX_INPUT_CHARS,
      embed: async (text) => {
        sent = text;
        return { ok: true, embedding: axis(0) };
      },
    });
    assert.equal(sent.length <= 2000, true);
    assert.equal(sent.startsWith('主机架设\n'), true);
    assert.equal(sent.includes(transcript), false);
    assert.equal(planned.row.status, 'ready');
    assert.equal(planned.row.contentHash, contentHash({ title: '主机架设', transcript }));
  });

  it('clears the old vector before a changed video is embedded again', () => {
    const stale = markStaleForRewrite(readyChunk('v1', 'old-hash', 0), 'new-hash', 5);
    assert.equal(stale.status, 'stale');
    assert.deepEqual(stale.embedding, []);
    assert.equal(markStaleForRewrite(readyChunk('v1', 'same-hash', 0), 'same-hash', 5), null);
  });

  it('marks a changed video stale without embedding when the model call is not configured', () => {
    const planned = planWithoutEmbed({
      video: { _id: 'v1', title: '新标题', status: 'published' },
      existing: readyChunk('v1', 'old-hash', 0),
      now: 10,
    });
    assert.equal(planned.row.status, 'stale');
    assert.deepEqual(planned.row.embedding, []);
  });
});

describe('index task', () => {
  it('resumes from the cursor and does not count the same video twice', () => {
    const task = createTask({
      taskId: 'task-1',
      taskType: 'brandRename',
      videoIds: ['a', 'b', 'a'],
      now: 1,
    });
    assert.deepEqual(task.videoIds, ['a', 'b']);
    assert.deepEqual(nextBatch(task, 1), ['a']);
    const once = applyBatch(task, [{ id: 'a', kind: 'success' }], 2);
    assert.equal(once.cursor, 'b');
    assert.equal(once.successCount, 1);
    const again = applyBatch(once, [{ id: 'a', kind: 'success' }, { id: 'b', kind: 'unchanged' }], 3);
    assert.equal(again.cursor, '');
    assert.equal(again.successCount, 1);
    assert.equal(again.status, 'completed');
    assert.equal(again.ready, undefined);
  });
});

describe('cosine probe', () => {
  it('lists every usable published video and keeps a low score', () => {
    const videos = [
      video({ _id: 'near', title: '对中', contentHash: 'h-near', publishedAt: 1 }),
      video({ _id: 'far', title: '建站', contentHash: 'h-far', publishedAt: 2 }),
      video({ _id: 'stale', title: '旧文案', contentHash: 'h-new', publishedAt: 3 }),
      video({ _id: 'draft', title: '草稿', status: 'draft', contentHash: 'h-draft' }),
    ];
    const chunks = [
      readyChunk('near', 'h-near', 0),
      readyChunk('far', 'h-far', 1),
      readyChunk('stale', 'h-old', 0),
    ];
    const scored = scorePublishedVideos({
      videos,
      chunks,
      queryEmbedding: axis(0),
    });
    assert.equal(scored.published, 3);
    assert.equal(scored.scored, 2);
    assert.deepEqual(scored.items, [
      { id: 'near', title: '对中', cosine: 1 },
      { id: 'far', title: '建站', cosine: 0 },
    ]);
  });
});
