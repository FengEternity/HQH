# search 模块稳定与高效优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉分析发现的两处 P0 静默缺口和两处 P1 降级，完成查询热路径的读缓存，并落地三路召回中属于骨架的 `find_videos` 与 `video_search@v1`。

**Architecture:** 全部改动沿用现有结构：`search` 云函数承载关键词路、RAG 路和 `find_videos`；`agent` 云函数承载 `video_search@v1` 的模型循环与三路合并；小程序最后切换调用方。RAG 近邻本身（嵌入模型、维度、余弦排序）不在本计划内，由同事负责。

**Tech Stack:** 微信云函数（Node.js）、`node:test`、不新增 npm 依赖。

## Global Constraints

- RAG 近邻的算法常量不改：`EMBEDDING_DIM=1024`、`EMBEDDING_MODEL='kinfra-text-embedding-0.6b'`、`COSINE_THRESHOLD=0.678` 仅用于运营探测、`VECTOR_CAP=500`。
- 关键词按钮只走关键词路。`video_doc` 不挂 `find_videos`。客服本期不接。`scene=product` 不检索。
- `search` 不运行模型循环；`agent` 不直连 `videos`、`search_chunks` 底表。
- 模型循环落在 20 秒预算内，一轮最多 3 次 `find_videos`，一次最多 8 张卡片。模型交回的 id 必须出现在本轮工具结果里。
- 不把三路分数合成一个分，不做 RRF。
- Commit 用简体中文，不写本地文档编号。不提交 `.npm-cache/` 与根 `package-lock.json`。
- 每个任务从 `dev` 迁一条短分支（任务头给出分支名），验收后合回 `dev`。
- 测试命令统一为 `node --test <files>`，在仓库根目录执行。

---

### Task 1: 收尾向量块缓存与封面补齐

**Branch:** `dev-ai-search-cache`（当前所在分支，改动已写好未提交）

**Files:**
- Modify: `cloudfunctions/search/index.js`
- Modify: `cloudfunctions/search/lib/resolvePosterUrls.js`
- Create: `cloudfunctions/search/lib/searchCatalogCache.js`
- Test: `cloudfunctions/search/lib/searchCatalogCache.test.js`、`cloudfunctions/search/lib/resolvePosterUrls.test.js`

**Interfaces:**
- Produces: `readCatalogChunks(videos, now)` / `writeCatalogChunks(videos, chunks, now)`（60 秒进程缓存，指纹为已发布 `id:contentHash` 排序拼接）；`attachResultPosters(result, getTempFileURL)`（同一张封面只换一次临时链，`items`、`keywordItems`、`semanticOnlyItems` 三处共用）。

- [ ] **Step 1: 确认测试通过**

Run: `node --test cloudfunctions/search/lib/searchCatalogCache.test.js cloudfunctions/search/lib/resolvePosterUrls.test.js cloudfunctions/search/lib/hybridSearch.test.js cloudfunctions/search/lib/queryEmbeddingCache.test.js miniprogram/pages/index/index.test.js`
Expected: PASS，43 项。

- [ ] **Step 2: Commit**

```bash
git add cloudfunctions/search/index.js cloudfunctions/search/lib/resolvePosterUrls.js cloudfunctions/search/lib/resolvePosterUrls.test.js cloudfunctions/search/lib/searchCatalogCache.js cloudfunctions/search/lib/searchCatalogCache.test.js
git commit -m "perf(search): 向量块一分钟内复用，两栏结果补齐封面"
```

- [ ] **Step 3: 合回 dev 并推送**

```bash
git checkout dev && git merge --ff-only dev-ai-search-cache && git push origin dev
```

---

### Task 2: 索引任务在函数预算内自推进

**Branch:** `dev-index-self-drive`（修 P0：品牌改名后只回填 1 条向量）

**Files:**
- Modify: `cloudfunctions/search/lib/indexTask.js`
- Modify: `cloudfunctions/search/index.js`（`advanceStoredTask` 改走 `driveIndexTask`，`handleStartTask` 同步）
- Test: `cloudfunctions/search/lib/indexTask.test.js`（新建）

**Interfaces:**
- Consumes: 现有 `createTask`、`nextBatch`、`applyBatch`、`taskView`；`indexOne(videoId)` 与 `saveTask(task)` 由 `index.js` 注入。
- Produces: `driveIndexTask({ task, budgetMs, now, indexOne, saveTask, batchSize }) -> taskView`。在 `budgetMs` 内循环跑批直到 `cursor` 清空；预算耗尽保留 `cursor`，状态 `running`。`TASK_DRIVE_BUDGET_MS = 45000`（函数超时 60 秒，留出读写余量）。

- [ ] **Step 1: Write the failing test**

```js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createTask, driveIndexTask } = require('./indexTask');

function taskOver(count) {
  const ids = [];
  for (let index = 0; index < count; index += 1) ids.push('v' + index);
  return createTask({ taskId: 't', taskType: 'brandRename', videoIds: ids, now: 0 });
}

const noSave = async () => {};

describe('driveIndexTask', () => {
  it('embeds every queued video in one call when work fits the budget', async () => {
    const embedded = [];
    const view = await driveIndexTask({
      task: taskOver(5),
      budgetMs: 1000,
      now: () => 0,
      indexOne: async (id) => { embedded.push(id); return { id, kind: 'success' }; },
      saveTask: noSave,
    });
    assert.equal(embedded.length, 5);
    assert.equal(view.status, 'completed');
    assert.equal(view.ready, 5);
  });

  it('stops at the budget and keeps the cursor for a later advance', async () => {
    let tick = -1;
    const view = await driveIndexTask({
      task: taskOver(10),
      budgetMs: 3,
      now: () => { tick += 1; return tick; },
      indexOne: async (id) => ({ id, kind: 'success' }),
      saveTask: noSave,
    });
    assert.equal(view.status, 'running');
    assert.ok(view.cursor);
  });

  it('counts a failed video and keeps driving the rest', async () => {
    const view = await driveIndexTask({
      task: taskOver(3),
      budgetMs: 1000,
      now: () => 0,
      indexOne: async (id) => ({ id, kind: id === 'v1' ? 'failed' : 'success', error: id === 'v1' ? 'embed_timeout' : '' }),
      saveTask: noSave,
    });
    assert.equal(view.status, 'partial');
    assert.equal(view.ready, 2);
    assert.equal(view.failed, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test cloudfunctions/search/lib/indexTask.test.js`
Expected: FAIL，`driveIndexTask` 未定义。

- [ ] **Step 3: Write minimal implementation**

`cloudfunctions/search/lib/indexTask.js` 追加：

```js
async function driveIndexTask({ task, budgetMs, now, indexOne, saveTask, batchSize = 1 }) {
  const startedAt = now();
  let current = task;
  while (current.cursor) {
    const ids = nextBatch(current, batchSize);
    if (!ids.length) break;
    const outcomes = [];
    for (const id of ids) {
      outcomes.push(await indexOne(id));
    }
    current = applyBatch(current, outcomes, now());
    if (now() - startedAt >= budgetMs) break;
  }
  await saveTask(current);
  return taskView(current);
}
```

`module.exports` 增加 `driveIndexTask`。`cloudfunctions/search/index.js`：

```js
const TASK_DRIVE_BUDGET_MS = 45000;

async function advanceStoredTask(task) {
  return driveIndexTask({
    task,
    budgetMs: TASK_DRIVE_BUDGET_MS,
    now: Date.now,
    indexOne,
    saveTask,
    batchSize: INDEX_BATCH_SIZE,
  });
}
```

`batchFailed` 只反映最后一批，累计计数在 `successCount/failedCount`，保持现状。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test cloudfunctions/search/lib/indexTask.test.js cloudfunctions/search/lib/hybridSearch.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/search/lib/indexTask.js cloudfunctions/search/lib/indexTask.test.js cloudfunctions/search/index.js
git commit -m "fix(search): 索引任务在一次调用内跑到完成或预算耗尽"
```

---

### Task 3: 已发布列表分页读全并提示截断

**Branch:** `dev-videos-paged-read`（修 P0：超过 1000 条静默缺片）

**Files:**
- Create: `cloudfunctions/search/lib/pagedRead.js`
- Test: `cloudfunctions/search/lib/pagedRead.test.js`（新建）
- Modify: `cloudfunctions/search/index.js`（`loadPublishedVideos` 走分页）
- Modify: `cloudfunctions/search/lib/mergeNotice.js`（`decideNotice` 增加 `libraryTruncated` 档）
- Modify: `cloudfunctions/search/lib/searchIndex.js`（`runSearch` 透传 `libraryTruncated`）
- Modify: `miniprogram/pages/index/searchNotice.js`
- Test: `miniprogram/pages/index/searchNotice.test.js`

**Interfaces:**
- Produces: `loadAllPages(fetchPage, { pageSize, hardCap }) -> { rows, truncated }`。`fetchPage(skip, limit)` 返回一页数组；取到短页为止；取满 `hardCap` 则 `truncated: true`。默认 `pageSize=1000`、`hardCap=5000`。
- Produces: `decideNotice` 在 `publishedCount` 之后最先判断 `state.libraryTruncated`，返回 `'library_overflow'`。`runSearch` 接受 `input.libraryTruncated` 并透传；notice 优先级高于其余各档。

- [ ] **Step 1: Write the failing tests**

`cloudfunctions/search/lib/pagedRead.test.js`：

```js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadAllPages } = require('./pagedRead');

function pagesOf(fullPages, lastPage) {
  return async (skip, limit) => {
    const pageIndex = skip / limit;
    if (pageIndex < fullPages) {
      return Array.from({ length: limit }, (_, i) => skip + i);
    }
    if (pageIndex === fullPages) {
      return Array.from({ length: lastPage }, (_, i) => skip + i);
    }
    return [];
  };
}

describe('loadAllPages', () => {
  it('reads two and a half pages to the end', async () => {
    const { rows, truncated } = await loadAllPages(pagesOf(2, 300), { pageSize: 1000, hardCap: 5000 });
    assert.equal(rows.length, 2300);
    assert.equal(rows[2299], 2299);
    assert.equal(truncated, false);
  });

  it('reports truncated when the cap is reached with full pages', async () => {
    const { rows, truncated } = await loadAllPages(pagesOf(9, 0), { pageSize: 100, hardCap: 300 });
    assert.equal(rows.length, 300);
    assert.equal(truncated, true);
  });
});
```

`miniprogram/pages/index/searchNotice.test.js` 追加：

```js
it('tells the visitor only part of the library was searched', () => {
  assert.equal(searchNoticeText('library_overflow', []), '讲解较多，本次只搜到其中一部分');
  assert.equal(searchNoticeText('library_overflow', [{ id: 'v1' }]), '讲解较多，本次只搜到其中一部分');
});
```

`cloudfunctions/search/lib/mergeNotice` 的行为断言（放进现有 `hybridSearch.test.js` 的 describe 之外新 describe）：

```js
const { decideNotice } = require('./mergeNotice');

describe('library overflow notice', () => {
  it('wins over every other notice', () => {
    assert.equal(
      decideNotice({ publishedCount: 6000, libraryTruncated: true, vectorEnabled: true, embedError: true }),
      'library_overflow',
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test cloudfunctions/search/lib/pagedRead.test.js miniprogram/pages/index/searchNotice.test.js cloudfunctions/search/lib/hybridSearch.test.js`
Expected: FAIL，`loadAllPages` 找不到、`library_overflow` 文案为空、`decideNotice` 返回旧档。

- [ ] **Step 3: Write minimal implementation**

`cloudfunctions/search/lib/pagedRead.js`：

```js
'use strict';

async function loadAllPages(fetchPage, { pageSize = 1000, hardCap = 5000 } = {}) {
  const rows = [];
  for (let skip = 0; skip < hardCap; skip += pageSize) {
    const page = (await fetchPage(skip, pageSize)) || [];
    rows.push.apply(rows, page);
    if (page.length < pageSize) {
      return { rows, truncated: false };
    }
  }
  return { rows, truncated: true };
}

module.exports = { loadAllPages };
```

`index.js` 的 `loadPublishedVideos` 改为返回 `{ videos, truncated }`，用 `loadAllPages((skip, limit) => db.collection('videos').where({ status: 'published' }).field({ ...现有字段 }).skip(skip).limit(limit).get().then((res) => res.data || []))`；`handleQuery` 解出后把 `libraryTruncated: truncated` 传给 `runSearch`。`mergeNotice.js` 在 `publishedCount` 判断之后加 `if (state.libraryTruncated) return 'library_overflow';`。`searchIndex.js` 把 `input.libraryTruncated` 透传进 `decideNotice`（关键词模式也要传）。`searchNotice.js` 在 `coverage_incomplete` 之前加：

```js
if (notice === 'library_overflow') {
  return '讲解较多，本次只搜到其中一部分';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test cloudfunctions/search/lib/pagedRead.test.js cloudfunctions/search/lib/hybridSearch.test.js miniprogram/pages/index/searchNotice.test.js miniprogram/pages/index/index.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/search/lib/pagedRead.js cloudfunctions/search/lib/pagedRead.test.js cloudfunctions/search/index.js cloudfunctions/search/lib/mergeNotice.js cloudfunctions/search/lib/searchIndex.js cloudfunctions/search/lib/hybridSearch.test.js miniprogram/pages/index/searchNotice.js miniprogram/pages/index/searchNotice.test.js
git commit -m "fix(search): 已发布列表分页读全，超出上限时明确提示"
```

---

### Task 4: 嵌入调用失败重试一次

**Branch:** `dev-embed-resilience`（修 P1：reindex 失败被吞、查询嵌入单次尝试）

**Files:**
- Modify: `cloudfunctions/catalog/lib/requestSearchIndex.js`
- Test: `cloudfunctions/catalog/lib/requestSearchIndex.test.js`
- Modify: `cloudfunctions/search/lib/queryEmbeddingCache.js`
- Test: `cloudfunctions/search/lib/queryEmbeddingCache.test.js`

**Interfaces:**
- Consumes: 现有 `requestSearchIndex(callFunction, data)`、`resolveQueryEmbedding({ db, sentence, embed, now, model })`。
- Produces: `requestSearchIndex` 在返回 `{ ok: false }` 或抛错时以同一 `data` 再调一次；`code === 'BAD_INPUT'` 不重试。`resolveQueryEmbedding` 在 `embed` 返回 `embed_timeout` / `embed_failed` 时再试一次；`bad_dimension` 不重试。

- [ ] **Step 1: Write the failing tests**

`cloudfunctions/catalog/lib/requestSearchIndex.test.js` 追加：

```js
it('retries once when the search function reports failure', async () => {
  const calls = [];
  const res = await requestSearchIndex(async (payload) => {
    calls.push(payload);
    return { result: calls.length === 1 ? { ok: false, code: 'FAIL' } : { ok: true, videoId: 'v1' } };
  }, { action: 'reindexVideo', videoId: 'v1' });
  assert.equal(calls.length, 2);
  assert.equal(res.ok, true);
});

it('does not retry a bad input', async () => {
  const calls = [];
  const res = await requestSearchIndex(async (payload) => {
    calls.push(payload);
    return { result: { ok: false, code: 'BAD_INPUT' } };
  }, { action: 'reindexVideo' });
  assert.equal(calls.length, 1);
  assert.equal(res.code, 'BAD_INPUT');
});
```

`cloudfunctions/search/lib/queryEmbeddingCache.test.js` 追加：

```js
it('retries a timed out embed once within the same resolve', async () => {
  const db = createDb();
  let calls = 0;
  const resolved = await resolveQueryEmbedding({
    db,
    sentence: '坐标换算',
    now: 10,
    embed: async () => {
      calls += 1;
      return calls === 1 ? { ok: false, error: 'embed_timeout' } : { ok: true, embedding: vector() };
    },
  });
  assert.equal(calls, 2);
  assert.equal(resolved.ok, true);
});

it('does not retry a bad dimension', async () => {
  const db = createDb();
  let calls = 0;
  const resolved = await resolveQueryEmbedding({
    db,
    sentence: '坐标换算',
    now: 10,
    embed: async () => {
      calls += 1;
      return { ok: false, error: 'bad_dimension' };
    },
  });
  assert.equal(calls, 1);
  assert.equal(resolved.ok, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test cloudfunctions/catalog/lib/requestSearchIndex.test.js cloudfunctions/search/lib/queryEmbeddingCache.test.js`
Expected: FAIL，重试断言不成立。

- [ ] **Step 3: Write minimal implementation**

`requestSearchIndex.js`：

```js
async function requestSearchIndex(callFunction, data) {
  if (typeof callFunction !== 'function') {
    return { ok: false, code: 'FAIL' };
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await callFunction({ name: 'search', data });
      const result = (res && res.result) || { ok: false, code: 'FAIL' };
      if (result.ok !== false || result.code === 'BAD_INPUT' || attempt === 1) {
        return result;
      }
    } catch (error) {
      if (attempt === 1) {
        return { ok: false, code: 'FAIL' };
      }
    }
  }
  return { ok: false, code: 'FAIL' };
}
```

`queryEmbeddingCache.js` 的 `resolveQueryEmbedding`：缓存未命中后循环最多 2 次 `embed(sentence)`，`error` 属于 `embed_timeout` / `embed_failed` 时继续，否则立即返回失败；两次都失败返回最后一次的 error。写缓存逻辑不变。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test cloudfunctions/catalog/lib/requestSearchIndex.test.js cloudfunctions/search/lib/queryEmbeddingCache.test.js`
Expected: PASS，含旧用例。

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/catalog/lib/requestSearchIndex.js cloudfunctions/catalog/lib/requestSearchIndex.test.js cloudfunctions/search/lib/queryEmbeddingCache.js cloudfunctions/search/lib/queryEmbeddingCache.test.js
git commit -m "fix(search): 索引请求和查询嵌入失败时在原调用内再试一次"
```

---

### Task 5: 索引对账 action

**Branch:** `dev-index-audit`（修 P1 的另一半：失败有人看得见）

**Files:**
- Modify: `cloudfunctions/search/lib/vectorRank.js`（导出 `usableChunk`，新增 `auditChunks`）
- Test: `cloudfunctions/search/lib/auditChunks.test.js`（新建）
- Modify: `cloudfunctions/search/index.js`（`handleOps` 增加 `auditIndex`）

**Interfaces:**
- Consumes: `usableChunk(video, chunk, modelName)`（现有内部函数）。
- Produces: `auditChunks(videos, chunks) -> { missing, stale }`。`missing`：已发布但没有向量块；`stale`：有块但哈希、模型、维度或模长不合格（判定与 `usableChunk` 完全一致）。ops action `auditIndex`（凭 ticket）返回 `{ ok: true, missing, stale, published }`，不带向量。

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test cloudfunctions/search/lib/auditChunks.test.js`
Expected: FAIL，`auditChunks` 未定义。

- [ ] **Step 3: Write minimal implementation**

`vectorRank.js` 追加并导出（`usableChunk` 一并导出）：

```js
function auditChunks(videos, chunks, model) {
  const modelName = model || EMBEDDING_MODEL;
  const byId = new Map();
  for (const chunk of chunks || []) {
    if (chunk && chunk.sourceId) byId.set(String(chunk.sourceId), chunk);
  }
  const missing = [];
  const stale = [];
  for (const video of videos || []) {
    if (!video || video.status !== 'published') continue;
    const chunk = byId.get(String(video._id));
    if (!chunk) {
      missing.push(String(video._id));
    } else if (!usableChunk(video, chunk, modelName)) {
      stale.push(String(video._id));
    }
  }
  return { missing, stale };
}
```

`index.js`：`handleOps` 增加分支 `auditIndex` → 并行 `loadPublishedVideos()` 与 `loadChunks(videos)`（先取 videos），返回 `{ ok: true, missing, stale, published }`。走 `requireAdmin`，与 `probeCosine` 同级。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test cloudfunctions/search/lib/auditChunks.test.js cloudfunctions/search/lib/hybridSearch.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/search/lib/vectorRank.js cloudfunctions/search/lib/auditChunks.test.js cloudfunctions/search/index.js
git commit -m "feat(search): 对账已发布讲解与向量块"
```

---

### Task 6: 目录读 60 秒热缓存

**Branch:** `dev-catalog-read-cache`（效率：每次查询剩余的最大读放大）

**Files:**
- Modify: `cloudfunctions/search/lib/searchCatalogCache.js`（新增 `createReadCache`）
- Test: `cloudfunctions/search/lib/searchCatalogCache.test.js`
- Modify: `cloudfunctions/search/index.js`（`loadPublishedVideos`、`loadSynonyms` 走缓存；写路径动作清缓存）

**Interfaces:**
- Produces: `createReadCache({ ttlMs }) -> { read(now), write(value, now), invalidate() }`。默认 `ttlMs = 60000`。`videos` 与 `synonyms` 各持有一个模块级实例。
- Consumes: `handleOps` 里 `reindexVideo`、`deleteChunk` 完成后调用两个实例的 `invalidate()`（同进程最佳努力，TTL 兜底）。

- [ ] **Step 1: Write the failing test**

`searchCatalogCache.test.js` 追加：

```js
const { createReadCache } = require('./searchCatalogCache');

describe('read cache', () => {
  it('serves the value for a minute and drops it on invalidate', () => {
    const cache = createReadCache({ ttlMs: 60000 });
    cache.write([{ _id: 'v1' }], 1000);
    assert.deepEqual(cache.read(1000 + 59999), [{ _id: 'v1' }]);
    assert.equal(cache.read(1000 + 60000), null);
    cache.write([{ _id: 'v2' }], 2000);
    cache.invalidate();
    assert.equal(cache.read(2000), null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test cloudfunctions/search/lib/searchCatalogCache.test.js`
Expected: FAIL，`createReadCache` 未定义。

- [ ] **Step 3: Write minimal implementation**

```js
function createReadCache({ ttlMs = CATALOG_TTL_MS } = {}) {
  let entry = null;
  return {
    read(now) {
      if (!entry || Number(now) - entry.storedAt >= ttlMs) return null;
      return entry.value;
    },
    write(value, now) {
      entry = { value, storedAt: Number(now) || 0 };
    },
    invalidate() {
      entry = null;
    },
  };
}
```

`index.js`：模块级 `const videosCache = createReadCache(); const synonymsCache = createReadCache();`。`handleQuery` 里改为先读缓存、未命中再 `loadPublishedVideos()` / `loadSynonyms()` 并写入（注意 Task 3 之后 `loadPublishedVideos` 返回 `{ videos, truncated }`，缓存整个返回值）。`handleOps` 的 `reindexVideo`、`deleteChunk` 分支末尾调用 `videosCache.invalidate()`。已知代价：新上架最长 60 秒才进关键词结果；`reindexVideo` 在同一实例被调用时会立即清缓存，覆盖运营「上架后立刻搜」的场景。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test cloudfunctions/search/lib/searchCatalogCache.test.js cloudfunctions/search/lib/pagedRead.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/search/lib/searchCatalogCache.js cloudfunctions/search/lib/searchCatalogCache.test.js cloudfunctions/search/index.js
git commit -m "perf(search): 目录与同义词一分钟内热缓存，写路径顺手清"
```

---

### Task 7: `find_videos` 与三路合并纯函数

**Branch:** `dev-find-videos`（三路骨架的 search 侧）

**Files:**
- Create: `cloudfunctions/search/lib/findVideos.js`
- Test: `cloudfunctions/search/lib/findVideos.test.js`（新建）
- Modify: `cloudfunctions/search/lib/mergeNotice.js`（新增 `mergeThreeLanes`、`decideThreeLaneNotice`，不改 `mergeVideos` / `decideNotice`）
- Test: `cloudfunctions/search/lib/threeLaneNotice.test.js`（新建）
- Modify: `cloudfunctions/search/index.js`（公开 action `findVideos`，不需 ticket）

**Interfaces:**
- Consumes: `expandQuery`（`keywordSearch.js`）。
- Produces: `findVideos(videos, query, synonyms) -> cards`。卡片字段：`id`、`title`、`brandName`、`brandId`、`modelName`、`tags`、`summary`（用 `intro`，没有则用 `searchAbstract`）、`coverFileId`。最多 8 条。只保留 `status === 'published'`，且 `searchBlob` 包含同义词替换后的整句。`coverFileId` 与 `brandId` 超出规格字段，是三路合并与封面临时链所需，在此声明。
- Produces: `mergeThreeLanes(keywordVideos, agentVideos, ragHits) -> videos`（`_id` 去重，顺序：关键词 → 只有 Agent 找到的 → 只有 RAG 找到的）；`decideThreeLaneNotice({ agentFailed, embedError, overCap, indexed, expected }) -> notice`，优先级 `agent_unavailable` → `semantic_unavailable` → `coverage_incomplete` → `''`。
- Produces: action `findVideos`：`{ action: 'findVideos', query }` → `{ ok: true, cards }`。只读已上架公开数据，与 query 同级，不要求 ticket。空白 query 返回 `{ ok: true, cards: [] }`。

- [ ] **Step 1: Write the failing tests**

`cloudfunctions/search/lib/findVideos.test.js`：

```js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { findVideos } = require('./findVideos');

const cors = {
  _id: 'cors',
  status: 'published',
  title: '南方CORS设置',
  intro: '演示南方手簿 CORS 连接与账号设置。',
  searchAbstract: '',
  brandName: '南方',
  brandId: 'b-south',
  modelName: '',
  tags: ['CORS'],
  coverFileId: 'cloud://cover-cors',
  searchBlob: '南方cors设置 演示南方手簿 cors 连接与账号设置。 南方 cors',
};

describe('findVideos', () => {
  it('hits a rewritten phrase and misses the original sentence', () => {
    assert.equal(findVideos([cors], '怎么设置账号', []).length, 0);
    const cards = findVideos([cors], '账号设置', []);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].id, 'cors');
    assert.equal(cards[0].summary, '演示南方手簿 CORS 连接与账号设置。');
    assert.equal(cards[0].coverFileId, 'cloud://cover-cors');
    assert.equal(cards[0].brandId, 'b-south');
    assert.equal(cards[0].score, undefined);
  });

  it('expands synonyms before matching the whole phrase', () => {
    const cards = findVideos([cors], ' Cors 账号 ', [{ alias: ' cors ', canonical: 'cors' }]);
    assert.equal(cards.length, 0);
    const hit = findVideos([cors], '账号设置', []);
    assert.equal(hit.length, 1);
  });

  it('returns at most 8 cards and skips drafts', () => {
    const videos = [];
    for (let index = 0; index < 9; index += 1) {
      videos.push(Object.assign({}, cors, { _id: 'v' + index }));
    }
    videos.push(Object.assign({}, cors, { _id: 'draft', status: 'draft' }));
    const cards = findVideos(videos, '账号设置', []);
    assert.equal(cards.length, 8);
    assert.equal(cards.some((card) => card.id === 'draft'), false);
  });

  it('falls back to searchAbstract when there is no intro', () => {
    const noIntro = Object.assign({}, cors, { intro: '', searchAbstract: 'CORS 摘要' });
    const cards = findVideos([noIntro], '账号设置', []);
    assert.equal(cards[0].summary, 'CORS 摘要');
  });
});
```

`cloudfunctions/search/lib/threeLaneNotice.test.js`：

```js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { decideThreeLaneNotice, mergeThreeLanes } = require('./mergeNotice');

function video(id) {
  return { _id: id, title: id };
}

describe('three lane merge', () => {
  it('keeps keyword order, then agent-only ids, then rag-only ids', () => {
    const merged = mergeThreeLanes(
      [video('keyword')],
      [video('agent'), video('keyword')],
      [{ video: video('rag'), cosine: 0.9 }, { video: video('agent'), cosine: 0.99 }],
    );
    assert.deepEqual(merged.map((item) => item._id), ['keyword', 'agent', 'rag']);
  });

  it('reports agent failure before semantic failure', () => {
    assert.equal(decideThreeLaneNotice({ agentFailed: true, embedError: true }), 'agent_unavailable');
    assert.equal(decideThreeLaneNotice({ embedError: true }), 'semantic_unavailable');
    assert.equal(decideThreeLaneNotice({ overCap: true }), 'semantic_unavailable');
    assert.equal(decideThreeLaneNotice({ indexed: 0, expected: 2 }), 'semantic_unavailable');
    assert.equal(decideThreeLaneNotice({ indexed: 1, expected: 2 }), 'coverage_incomplete');
    assert.equal(decideThreeLaneNotice({ indexed: 2, expected: 2 }), '');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test cloudfunctions/search/lib/findVideos.test.js cloudfunctions/search/lib/threeLaneNotice.test.js`
Expected: FAIL，模块或导出不存在。

- [ ] **Step 3: Write minimal implementation**

`findVideos.js`：用 `expandQuery(query, synonyms).join(' ')` 得到整句，为空返回 `[]`；过滤已上架且 `searchBlob` 含整句的视频，截 8 条，映射为卡片。不读向量，不调 `agent`。

`mergeNotice.js`：`mergeThreeLanes` 依次追加三路并用 `_id` 去重；`decideThreeLaneNotice` 按接口优先级返回。两个现有函数保持原样。

`index.js` 的 `handle`：

```js
async function handle(event) {
  if (event && event.action === 'findVideos') {
    return handleFindVideos(event);
  }
  if (event && event.action) {
    return handleOps(event);
  }
  return handleQuery(event);
}

async function handleFindVideos(event) {
  const query = String((event && event.query) || '').trim();
  if (!query) {
    return { ok: true, cards: [] };
  }
  const loaded = await loadPublishedVideos();
  const videos = loaded.videos || loaded; // 兼容 Task 3 前后的返回形状
  const synonyms = await loadSynonyms();
  return { ok: true, cards: findVideos(videos, query, synonyms) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test cloudfunctions/search/lib/findVideos.test.js cloudfunctions/search/lib/threeLaneNotice.test.js cloudfunctions/search/lib/hybridSearch.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/search/lib/findVideos.js cloudfunctions/search/lib/findVideos.test.js cloudfunctions/search/lib/mergeNotice.js cloudfunctions/search/lib/threeLaneNotice.test.js cloudfunctions/search/index.js
git commit -m "feat(search): 为模型找片增加 find_videos 与三路合并"
```

---

### Task 8: `video_search@v1` 模型循环

**Branch:** `dev-video-search-lane`（三路骨架的 agent 侧）

**Files:**
- Modify: `shared/ai-runtime/index.js`（`resolveTextModel` 的 `keys` 增加 `video_search`），随后运行 `node scripts/sync-ai-runtime.js`
- Modify: `cloudfunctions/agent/lib/agentModels.js`（`PLACES` 增加 `video_search`）
- Test: `cloudfunctions/agent/lib/agentModels.test.js`
- Create: `cloudfunctions/agent/lib/videoSearchLane.js`
- Test: `cloudfunctions/agent/lib/videoSearchLane.test.js`（新建）
- Modify: `cloudfunctions/agent/index.js`（action `videoSearch`）

**Interfaces:**
- Consumes: `createTokenHubClient({ env }).chat({ model, messages, tools, tool_choice, timeoutMs, deadline })`（`message` 可含 `tool_calls`）；`loadPlaceModelName(db, 'video_search', env)`；`checkText(query)`（`index.js` 现有）；`cloud.callFunction({ name: 'search', data: { action: 'findVideos', query } })`。
- Produces: `parseProposedIds(text) -> string[]`：从模型最后一轮文本取 JSON 数组（优先匹配 `[...]`），否则按换行/逗号/空白切；去重保序。
- Produces: `mergeThreeLaneItems({ keywordItems, proposedIds, cardById, semanticOnlyItems }) -> items`：LLM 路取 `proposedIds` 中出现在 `cardById` 的 id 并保序，卡片映射成与 `keywordItems` 相同的 item 形状（`type: 'video'`）；去重顺序关键词 → LLM → RAG。
- Produces: `runVideoSearchLoop({ chat, model, query, findVideos, now, budgetMs, maxCalls }) -> { ok, proposedIds, cardById, calls, error? }`。循环：模型返回 `tool_calls` 则执行 `find_videos`（计入 `calls`，达到 `maxCalls=3` 后下一轮 `tool_choice: 'none'`）；无 `tool_calls` 时 `parseProposedIds` 收尾。预算 `budgetMs=20000`，超时或模型报错返回 `{ ok: false, error }`。任何失败不抛出。
- Produces: action `videoSearch`：`{ action: 'videoSearch', query }` → `{ ok: true, scene: 'video', items, notice? }`。流程：`checkText`（拒绝则 `agentFailed` 处理，不调用模型）→ 并行 `search({ scene:'video', query, mode:'ai' })` 与 `runVideoSearchLoop` → `mergeThreeLaneItems` → notice 用 `decideThreeLaneNotice`（`agentFailed` 或 search 透传的 `embedError` 等状态；search 已算好 notice 时按优先级与 `agent_unavailable` 比较）。

- [ ] **Step 1: Write the failing tests**

`cloudfunctions/agent/lib/agentModels.test.js` 追加：

```js
it('defaults video_search to hy3 and accepts a stored model', () => {
  assert.equal(resolvePlaceModel({ place: 'video_search', stored: null, env: {} }), 'hy3');
  assert.equal(
    resolvePlaceModel({ place: 'video_search', stored: { video_search: 'glm-5.3-flash' }, env: {} }),
    'glm-5.3-flash',
  );
});
```

`cloudfunctions/agent/lib/videoSearchLane.test.js`：

```js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mergeThreeLaneItems, parseProposedIds, runVideoSearchLoop } = require('./videoSearchLane');

describe('parseProposedIds', () => {
  it('reads a json array and drops duplicates', () => {
    assert.deepEqual(parseProposedIds('找到这些：["cors", "rtk", "cors"]'), ['cors', 'rtk']);
    assert.deepEqual(parseProposedIds('cors\nrtk'), ['cors', 'rtk']);
    assert.deepEqual(parseProposedIds(''), []);
  });
});

describe('mergeThreeLaneItems', () => {
  const keywordItems = [{ type: 'video', id: 'kw', title: '关键词' }];
  const semanticOnlyItems = [{ type: 'video', id: 'rag', title: '语义' }];
  const cardById = {
    llm: { id: 'llm', title: '模型找的', brandName: '南方', brandId: 'b1', modelName: '', tags: [], summary: 's', coverFileId: 'cloud://c' },
  };

  it('keeps only proposed ids the tool returned, in order', () => {
    const items = mergeThreeLaneItems({
      keywordItems,
      proposedIds: ['missing', 'llm', 'kw'],
      cardById,
      semanticOnlyItems,
    });
    assert.deepEqual(items.map((item) => item.id), ['kw', 'llm', 'rag']);
    assert.equal(items[1].coverFileId, 'cloud://c');
    assert.equal(items[1].type, 'video');
  });
});

describe('runVideoSearchLoop', () => {
  const card = { id: 'cors', title: '南方CORS设置', brandName: '南方', brandId: 'b1', modelName: '', tags: [], summary: 's', coverFileId: '' };

  it('rewrites once, calls the tool, and finishes with the proposed ids', async () => {
    const seen = [];
    const result = await runVideoSearchLoop({
      model: 'hy3',
      query: '怎么设置账号',
      now: () => 0,
      budgetMs: 20000,
      maxCalls: 3,
      findVideos: async (query) => { seen.push(query); return [card]; },
      chat: async ({ messages, tool_choice }) => {
        const toolTurns = messages.filter((m) => m.role === 'tool').length;
        if (toolTurns === 0) {
          return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'find_videos', arguments: '{"query":"账号设置"}' } }] } };
        }
        assert.equal(tool_choice, 'auto');
        return { message: { role: 'assistant', content: '["cors"]' } };
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(seen, ['账号设置']);
    assert.deepEqual(result.calls, ['账号设置']);
    assert.deepEqual(result.proposedIds, ['cors']);
    assert.ok(result.cardById.cors);
  });

  it('fails closed when the model throws', async () => {
    const result = await runVideoSearchLoop({
      model: 'hy3',
      query: '怎么设置账号',
      now: () => 0,
      budgetMs: 20000,
      maxCalls: 3,
      findVideos: async () => [],
      chat: async () => { const e = new Error('UNAVAILABLE'); e.code = 'UNAVAILABLE'; throw e; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'UNAVAILABLE');
    assert.deepEqual(result.proposedIds, []);
  });

  it('forces the model to wrap up after the third tool call', async () => {
    const choices = [];
    const result = await runVideoSearchLoop({
      model: 'hy3',
      query: '怎么设置账号',
      now: () => 0,
      budgetMs: 20000,
      maxCalls: 3,
      findVideos: async () => [card],
      chat: async ({ tool_choice }) => {
        choices.push(tool_choice);
        if (choices.length <= 3) {
          return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'c' + choices.length, type: 'function', function: { name: 'find_videos', arguments: '{"query":"q' + choices.length + '"}' } }] } };
        }
        assert.equal(tool_choice, 'none');
        return { message: { role: 'assistant', content: '["cors"]' } };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.calls.length, 3);
    assert.equal(choices[3], 'none');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test cloudfunctions/agent/lib/videoSearchLane.test.js cloudfunctions/agent/lib/agentModels.test.js`
Expected: FAIL，模块未定义、`video_search` 不是合法 place。

- [ ] **Step 3: Write minimal implementation**

`shared/ai-runtime/index.js` 的 `keys` 增加 `video_search: 'TOKENHUB_VIDEO_SEARCH_MODEL'`，运行 `node scripts/sync-ai-runtime.js`，确认 `cloudfunctions/agent/lib/ai-runtime.js` 与 `scripts/video-ingest/lib/ai-runtime.js` 同步。`agentModels.js` 的 `PLACES` 增加 `{ id: 'video_search', label: 'AI 搜索', hint: '讲解页 AI 搜索改写查询时使用' }`。

`videoSearchLane.js` 要点：

```js
const VIDEO_SEARCH_SYSTEM = [
  '你在为一个测量仪器讲解小程序找已上架的讲解视频。',
  '用户原句可能不是视频里的写法。你可以把原句改写成更短的词，多次调用 find_videos。',
  'find_videos 只认整句连续出现：把「怎么设置账号」收成「账号设置」才查得到。',
  '不要闲聊。找齐或次数用尽后，最后一轮只输出一个 JSON 数组，元素是你认定相关的视频 id。',
  'id 必须来自本轮 find_videos 返回的卡片，不要自己编。',
].join('\n');
```

`runVideoSearchLoop`：初始 `messages = [{ role: 'system', content: VIDEO_SEARCH_SYSTEM }, { role: 'user', content: query }]`；循环内 `now() - startedAt >= budgetMs` 直接返回 `{ ok: false, error: 'TIMEOUT', proposedIds: [], cardById: {}, calls }`；`chat` 抛错记 `error.code || 'UNAVAILABLE'` 失败返回；有 `tool_calls` 且 `calls.length < maxCalls` 时逐个执行 `findVideos(parsedArgs.query)`，卡片合入 `cardById`，追加 tool 消息；`calls.length` 达到 `maxCalls` 后下一轮 `tool_choice: 'none'`；无 `tool_calls` 时 `parseProposedIds(message.content)` 成功返回。

`agent/index.js`：action `videoSearch` 分支，放在 `handleAgentEvent` 之前：

```js
if (action === 'videoSearch') {
  return await handleVideoSearch(event);
}
```

`handleVideoSearch`：`query` 空白返回 `{ ok: true, scene: 'video', items: [] }`；先 `checkText(query)`，`CONTENT_REJECTED` 记 `agentFailed = true` 且不启动模型循环；否则并行：

```js
const [searchResult, lane] = await Promise.all([
  cloud.callFunction({ name: 'search', data: { scene: 'video', query, mode: 'ai' } }).then((res) => res.result || { ok: false }),
  agentFailed ? Promise.resolve({ ok: false, error: 'CONTENT_REJECTED', proposedIds: [], cardById: {}, calls: [] }) : runVideoSearchLoop({ chat, model, query, findVideos, now: Date.now, budgetMs: 20000, maxCalls: 3 }),
]);
```

`findVideos = (q) => cloud.callFunction({ name: 'search', data: { action: 'findVideos', query: q } }).then((res) => (res.result && res.result.cards) || [])`。search 失败（`ok: false`）整次返回 `{ ok: false, code: 'FAIL' }`；否则 `mergeThreeLaneItems` 合并，notice 由 `agentFailed` 与 search 透传的 notice 按 `decideThreeLaneNotice` 的优先级折算：search 的 `semantic_unavailable` / `coverage_incomplete` 原样透出，`agentFailed` 时改为 `agent_unavailable`。模型名用 `loadPlaceModelName(db, 'video_search', runtimeEnv())`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test cloudfunctions/agent/lib/videoSearchLane.test.js cloudfunctions/agent/lib/agentModels.test.js cloudfunctions/agent/lib/videoDocModel.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add shared/ai-runtime/index.js cloudfunctions/agent/lib/ai-runtime.js scripts/video-ingest/lib/ai-runtime.js cloudfunctions/agent/lib/agentModels.js cloudfunctions/agent/lib/agentModels.test.js cloudfunctions/agent/lib/videoSearchLane.js cloudfunctions/agent/lib/videoSearchLane.test.js cloudfunctions/agent/index.js
git commit -m "feat(agent): AI 搜索第三路改写查询并合并三路召回"
```

---

### Task 9: 讲解页 AI 搜索改调 agent

**Branch:** `dev-ai-search-switch`（三路骨架的客户端侧，最后做）

**Files:**
- Modify: `miniprogram/pages/index/searchNotice.js`（`agent_unavailable` 文案）
- Test: `miniprogram/pages/index/searchNotice.test.js`
- Modify: `miniprogram/pages/index/index.js`（AI 分支改调 `agent` 的 `videoSearch`）
- Modify: `miniprogram/pages/index/index.wxml`（AI 模式只画单栏）
- Test: `miniprogram/pages/index/index.test.js`

**Interfaces:**
- Consumes: `searchNoticeText(notice, items)`；`callFunction({ name, data })`。
- Produces: AI 模式调用 `agent({ action: 'videoSearch', query })`，返回 `{ ok, items, notice? }` 时 `results` 直接用 `items`，`keywordResults` 置空、对应区块不渲染；返回形状不符（旧 agent 未上线）时退回现有 `search` 双栏路径。关键词按钮路径不变。
- Produces: `searchNoticeText('agent_unavailable', items)`：有条目时「AI 找片暂时不可用，以下是其他结果」，无条目时「AI 找片暂时不可用」。

- [ ] **Step 1: Write the failing tests**

`searchNotice.test.js` 追加：

```js
it('labels an agent outage without hiding the other lanes', () => {
  assert.equal(searchNoticeText('agent_unavailable', []), 'AI 找片暂时不可用');
  assert.equal(searchNoticeText('agent_unavailable', [{ id: 'v1' }]), 'AI 找片暂时不可用，以下是其他结果');
});
```

`index.test.js`：先把 `loadPage` 扩成三个参数（第三个是 `agent` 桩，缺省抛 `FAIL`），在 `require(pagePath)` 前替换 `api.agent`，加载后恢复。然后追加：

```js
it('routes ai search to the agent and renders one merged list', async () => {
  const calls = [];
  const page = loadPage(
    async () => ({ ok: true, brands: [], videos: [] }),
    async () => { throw fail('FAIL', 'search 不该被调用'); },
    async (data) => {
      calls.push(data);
      return {
        ok: true,
        scene: 'video',
        items: [{ id: 'cors', title: '南方CORS设置', brandId: 'b1', brandName: '南方', modelName: '', tags: [] }],
      };
    },
  );
  page.setData({ query: '怎么设置账号', queryMode: 'ai' });

  await page.onSearchConfirm();

  assert.deepEqual(calls, [{ action: 'videoSearch', query: '怎么设置账号' }]);
  assert.equal(page.data.searchMode, 'ai');
  assert.equal(page.data.aiLabel, 'AI 搜索结果');
  assert.deepEqual(page.data.results.map((item) => item.id), ['cors']);
  assert.deepEqual(page.data.keywordResults, []);
  assert.equal(page.data.agentMerged, true);
});

it('falls back to the two lane search when the agent call fails', async () => {
  const agentCalls = [];
  const searchCalls = [];
  const page = loadPage(
    async () => ({ ok: true, brands: [], videos: [] }),
    async (data) => {
      searchCalls.push(data);
      return {
        ok: true,
        scene: 'video',
        items: [{ id: 'kw', title: '参数计算', brandId: 'b1', brandName: '南方', modelName: '', tags: [] }],
        keywordItems: [{ id: 'kw', title: '参数计算', brandId: 'b1', brandName: '南方', modelName: '', tags: [] }],
        semanticOnlyItems: [],
      };
    },
    async (data) => {
      agentCalls.push(data);
      throw fail('FUNCTION_NOT_FOUND', 'agent 云函数未部署');
    },
  );
  page.setData({ query: '怎么计算', queryMode: 'ai' });

  await page.onSearchConfirm();

  assert.equal(agentCalls.length, 1);
  assert.deepEqual(searchCalls, [{ scene: 'video', mode: 'ai', query: '怎么计算' }]);
  assert.equal(page.data.agentMerged, false);
  assert.deepEqual(page.data.keywordResults.map((item) => item.id), ['kw']);
});
```

触发方式与现有用例一致：`setData({ query, queryMode: 'ai' })` 后 `await page.onSearchConfirm()`。现有的 `ai search sends the ai mode and labels the result` 与 `keeps vector-only hits above the keyword results` 两条用例被上面两条取代（旧行为是 AI 模式直调 `search`）。

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test miniprogram/pages/index/searchNotice.test.js miniprogram/pages/index/index.test.js`
Expected: FAIL，新断言不成立。

- [ ] **Step 3: Write minimal implementation**

`searchNotice.js` 在 `coverage_incomplete` 之前加 `agent_unavailable` 分支。`index.js` 的 `submitSearch` AI 分支：先调 `agent`，`result.ok` 且 `Array.isArray(result.items)` 时单栏渲染并记录 `notice`；否则走现有 `search` 双栏逻辑。`index.wxml`：`keywordResults` 所在区块的 `wx:if` 增加 `searchMode !== 'ai' || keywordResults.length` 之外的合并条件——AI 模式且 `agentMerged` 为真时不渲染该区块（用 `data.agentMerged` 标志，fallback 时为 false，保持现状渲染）。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test miniprogram/pages/index/index.test.js miniprogram/pages/index/searchNotice.test.js`
Expected: PASS，含旧的 11 项搜索用例。

- [ ] **Step 5: Commit**

```bash
git add miniprogram/pages/index/index.js miniprogram/pages/index/index.wxml miniprogram/pages/index/index.test.js miniprogram/pages/index/searchNotice.js miniprogram/pages/index/searchNotice.test.js
git commit -m "feat(search): AI 搜索改调 agent 三路召回"
```

---

### Task 10: 卫生项（可选，最后）

**Branch:** `dev-search-hygiene`

**Files:**
- Modify: `cloudfunctions/search/index.js`（ops action `cleanupQueryCache`）
- Modify: `cloudfunctions/catalog/index.js`（`syncBrandName` 分页读全）

- [ ] **Step 1: `cleanupQueryCache`**：凭 ticket；分页读 `search_query_cache`，删除 `updatedAt` 早于 `now - 2 * QUERY_CACHE_TTL_MS` 的行，返回 `{ ok, removed }`。复用 Task 3 的 `loadAllPages`。

- [ ] **Step 2: `syncBrandName` 分页**：`limit(200)` 改为 `loadAllPages` 同款循环（catalog 内联或抽 `cloudfunctions/catalog/lib/pagedRead.js`，与 search 侧同形），超过 200 条的品牌不再静默漏刷。

- [ ] **Step 3: Commit**

```bash
git add cloudfunctions/search/index.js cloudfunctions/catalog/index.js cloudfunctions/catalog/lib/pagedRead.js
git commit -m "chore(search): 清理过期查询向量，品牌改名分页刷新"
```

---

## 最终验收测试矩阵

### 单元测试（全部应 PASS）

| 文件 | 覆盖 |
| --- | --- |
| `cloudfunctions/search/lib/searchCatalogCache.test.js` | 向量块指纹缓存、目录读缓存、invalidate |
| `cloudfunctions/search/lib/resolvePosterUrls.test.js` | 三处结果共用一次临时链补齐 |
| `cloudfunctions/search/lib/queryEmbeddingCache.test.js` | 24 小时查询缓存、维度校验、超时重试一次、坏维度不重试 |
| `cloudfunctions/search/lib/indexTask.test.js` | 任务自推进到完成、预算耗尽保留游标、失败计数 |
| `cloudfunctions/search/lib/pagedRead.test.js` | 分页读全、到顶截断标记 |
| `cloudfunctions/search/lib/hybridSearch.test.js` | 两路合并、门槛不滤空、`library_overflow` 优先 |
| `cloudfunctions/search/lib/auditChunks.test.js` | missing / stale 对账 |
| `cloudfunctions/search/lib/findVideos.test.js` | 整句连续子串、同义词、8 条上限、摘要回退 |
| `cloudfunctions/search/lib/threeLaneNotice.test.js` | 三路合并顺序、notice 优先级 |
| `cloudfunctions/catalog/lib/requestSearchIndex.test.js` | 失败重试一次、BAD_INPUT 不重试 |
| `cloudfunctions/agent/lib/videoSearchLane.test.js` | id 解析、三路 item 合并、循环驱动、3 次上限、失败收口 |
| `cloudfunctions/agent/lib/agentModels.test.js` | `video_search` 配置位 |
| `miniprogram/pages/index/searchNotice.test.js` | 四档 notice 文案 |
| `miniprogram/pages/index/index.test.js` | AI 改调 agent、单栏渲染、旧 agent 回退双栏、关键词路径不变 |

### 云端端到端用例（部署 search、agent、catalog 与小程序后手测）

1. **品牌改名回填**：把一个品牌改名，等 1 分钟后用新品牌名做 AI 搜索。期望：语义路能命中该品牌的片，不出现「结果可能不全」；`auditIndex` 的 `stale` 为空。
2. **超过 500 条**：已发布 501 条时 AI 搜索显示「语义检索暂不可用」的文案，关键词结果完整；超过 1000 条时不再静默缺片。
3. **TokenHub 抖动**：临时把 `TOKENHUB_API_KEY` 改错，做一次 AI 搜索。期望：仍出关键词结果，notice 为语义不可用；改回后同一句 24 小时内不再调用 TokenHub（看嵌入调用日志只出现一次）。
4. **第三路改写**：发布一条简介含「账号设置」的讲解，搜「怎么设置账号」。期望：AI 搜索单栏出现该片；关键词按钮搜同一句不命中（整句不连续）、且全程无模型调用（agent 无日志）。
5. **模型故障**：把 `admin_config/agent_models` 的 `video_search` 改成不存在的模型名（或拔掉 `TCB_API_KEY`），AI 搜索仍出关键词与 RAG 结果，文案为「AI 找片暂时不可用，以下是其他结果」。
6. **重复查询**：同一短句连续两次 AI 搜索。期望：第二次无嵌入调用、无向量块读库（60 秒进程缓存内），响应明显快于第一次。
7. **回退**：只部署小程序、不部署 agent 新版本时，AI 搜索退回旧双栏，不出现空结果。

### 部署清单

- 云函数：`search`（Task 1–7、10）、`catalog`（Task 4、10）、`agent`（Task 8）。
- 小程序上传：Task 3（文案）、Task 9（切换）。
- 运营配置：`admin_config/agent_models` 增加 `video_search` 字段（不配时默认 `hy3`）。
