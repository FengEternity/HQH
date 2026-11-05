# 三路召回试跑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用替身模型证明「怎么设置账号」能召回简介里写着「账号设置」的已上架讲解。

**Architecture:** 试跑只加纯函数，不改讲解页，不调用 TokenHub。关键词召回沿用现网 AND。RAG 召回按余弦取前 8 条，不再用 0.678 滤空。`find_videos` 只做整句连续子串。替身 `video_search` 把原句改写成「账号设置」再查，合并时关键词在前，Agent 多找到的其次，RAG 多找到的最后。

**Tech Stack:** 云函数现有 `node:test`。不新增 npm 依赖。

## Global Constraints

- 关键词按钮只走关键词召回。本试跑不改小程序。
- `find_videos` 不调用外层三路搜索。
- 模型交回的 id 必须出现在本轮 `find_videos` 的卡片里。
- RAG 召回最多 8 条。低于 0.678 的块可以留下。
- 一轮 `find_videos` 最多 3 次，一次最多 8 张卡片。
- 关键词读库失败不在本试跑里模拟云数据库；纯函数只表达 notice 优先级。
- `video_doc` 不挂 `find_videos`。客服本期不接。
- Commit 用简体中文。不写本地文档编号。
- 分支 `dev-video-search-trial` 从当前 `main` 迁出。`dev` 上还没有同时具备 `search` 与 `agent` 的代码。

试跑不做：讲解页改调 `agent`、内容安全、真实模型改写、`customer_service`、点击日志排序。

---

### Task 1: `find_videos`

**Files:**
- Create: `cloudfunctions/search/lib/findVideos.js`
- Test: `cloudfunctions/search/lib/findVideos.test.js`

**Interfaces:**
- Consumes: `expandQuery` from `cloudfunctions/search/lib/keywordSearch.js`
- Produces: `findVideos(videos, query, synonyms) -> cards`。卡片字段为 `id`、`title`、`brandName`、`modelName`、`tags`、`summary`。`summary` 用 `intro`，没有则用 `searchAbstract`。最多 8 条。只保留 `status === 'published'`，且 `searchBlob` 包含同义词替换后的整句。

- [ ] **Step 1: Write the failing test**

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
  modelName: '',
  tags: ['CORS'],
  searchBlob: '南方cors设置 演示南方手簿 cors 连接与账号设置。 南方 cors',
};

describe('findVideos', () => {
  it('hits a rewritten phrase and misses the original sentence', () => {
    assert.equal(findVideos([cors], '怎么设置账号', []).length, 0);
    const cards = findVideos([cors], '账号设置', []);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].id, 'cors');
    assert.equal(cards[0].summary, '演示南方手簿 CORS 连接与账号设置。');
    assert.equal(cards[0].score, undefined);
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test cloudfunctions/search/lib/findVideos.test.js`

Expected: FAIL，找不到 `./findVideos`。

- [ ] **Step 3: Write minimal implementation**

`findVideos` 用 `expandQuery(query, synonyms).join(' ')` 得到整句。整句为空则返回 `[]`。过滤已上架且 `searchBlob` 包含该整句的视频，截到 8 条，映射成卡片。不读取向量，不调用 `agent`。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test cloudfunctions/search/lib/findVideos.test.js`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/search/lib/findVideos.js cloudfunctions/search/lib/findVideos.test.js
git commit -m "$(cat <<'EOF'
feat(search): 为 Agent 增加可改写查询的找片接口

EOF
)"
```

---

### Task 2: RAG 召回不再用门槛滤空

**Files:**
- Modify: `cloudfunctions/search/lib/vectorRank.js`
- Test: `cloudfunctions/search/lib/hybridSearch.test.js`

**Interfaces:**
- Consumes: 现有 `usableChunk`、`cosine`
- Produces: `selectRagRecall({ videos, chunks, queryEmbedding, model }) -> { hits, indexed, expected }`。`hits` 最多 8 条，按余弦从高到低，不看 `COSINE_THRESHOLD`。现有 `selectVectorHits` 保持原样，供旧测试使用。

- [ ] **Step 1: Write the failing test**

在 `hybridSearch.test.js` 增加：

```js
const { selectRagRecall } = require('./vectorRank');

it('keeps the nearest video when its cosine is below the old cutoff', () => {
  const item = video({ _id: 'cors', contentHash: 'hash-1', searchBlob: '账号设置' });
  const ranked = selectRagRecall({
    videos: [item],
    chunks: [readyChunk('cors', 'hash-1', 1)],
    queryEmbedding: axis(0),
  });
  assert.equal(ranked.hits.length, 1);
  assert.equal(ranked.hits[0].video._id, 'cors');
  assert.ok(ranked.hits[0].cosine < 0.678);
});
```

`axis(0)` 与 `axis(1)` 的余弦是 0，低于 0.678。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test cloudfunctions/search/lib/hybridSearch.test.js`

Expected: FAIL，`selectRagRecall` 未定义。

- [ ] **Step 3: Write minimal implementation**

`selectRagRecall` 复用 `selectVectorHits` 的可用块判断和排序，调用时传入 `threshold: -1`，从而保留余弦低于 0.678 的块，仍只取前 8 条。不改 `selectVectorHits` 的门槛参数语义。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test cloudfunctions/search/lib/hybridSearch.test.js`

Expected: PASS。旧的「低于门槛不追加」测试仍然 PASS。

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/search/lib/vectorRank.js cloudfunctions/search/lib/hybridSearch.test.js
git commit -m "$(cat <<'EOF'
feat(search): RAG 召回按相似度取前 8 条

EOF
)"
```

---

### Task 3: 三路合并和 notice

**Files:**
- Modify: `cloudfunctions/search/lib/mergeNotice.js`
- Test: `cloudfunctions/search/lib/threeLaneNotice.test.js`

**Interfaces:**
- Consumes: 视频对象含 `_id`。RAG 命中形如 `{ video, cosine }`。
- Produces:
  - `mergeThreeLanes(keywordVideos, agentVideos, ragHits) -> videos`
  - `decideThreeLaneNotice({ agentFailed, embedError, overCap, indexed, expected }) -> notice`。`agentFailed` 优先于 RAG 的 `semantic_unavailable`，再优先于 `coverage_incomplete`。都没问题时返回空字符串。

- [ ] **Step 1: Write the failing test**

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
    assert.equal(
      decideThreeLaneNotice({ indexed: 1, expected: 2 }),
      'coverage_incomplete',
    );
    assert.equal(decideThreeLaneNotice({ indexed: 2, expected: 2 }), '');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test cloudfunctions/search/lib/threeLaneNotice.test.js`

Expected: FAIL，导出的函数不存在。

- [ ] **Step 3: Write minimal implementation**

`mergeThreeLanes` 依次追加三路，用 `_id` 去重。`decideThreeLaneNotice` 按这个顺序返回：`agentFailed` 为真则 `agent_unavailable`；`embedError`、`overCap` 或 `expected > 0 && indexed === 0` 则 `semantic_unavailable`；`indexed < expected` 则 `coverage_incomplete`；否则返回空字符串。不修改现有 `decideNotice` 和 `mergeVideos`。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test cloudfunctions/search/lib/threeLaneNotice.test.js cloudfunctions/search/lib/hybridSearch.test.js`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/search/lib/mergeNotice.js cloudfunctions/search/lib/threeLaneNotice.test.js
git commit -m "$(cat <<'EOF'
feat(search): 合并关键词、Agent 和 RAG 三路召回

EOF
)"
```

---

### Task 4: 替身 Agent 跑通「怎么设置账号」

**Files:**
- Create: `cloudfunctions/agent/lib/videoSearchTrial.js`
- Test: `cloudfunctions/agent/lib/videoSearchTrial.test.js`

**Interfaces:**
- Consumes: `findVideos`、`mergeThreeLanes`、`decideThreeLaneNotice`、`selectRagRecall`
- Produces: `runVideoSearchTrial({ query, videos, synonyms, ragHits, embedError, rewrite, maxCalls }) -> { items, notice, calls }`。`rewrite(query, calls)` 返回下一次要传给 `find_videos` 的短查询；返回空字符串就停止。`calls` 最多 3。`items` 里的 id 必须来自某次 `findVideos` 卡片，或来自关键词路、RAG 路。替身不调用网络。

- [ ] **Step 1: Write the failing test**

```js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildSearchBlob } = require('../../search/lib/keywordSearch');
const { runVideoSearchTrial } = require('./videoSearchTrial');

const cors = {
  _id: 'cors',
  status: 'published',
  title: '南方CORS设置',
  intro: '演示南方手簿 CORS 连接与账号设置。',
  brandName: '南方',
  modelName: '',
  tags: ['CORS'],
  publishedAt: 1,
};
cors.searchBlob = buildSearchBlob(cors);

describe('video search trial', () => {
  it('recalls the account video by rewriting the query', () => {
    const result = runVideoSearchTrial({
      query: '怎么设置账号',
      videos: [cors],
      synonyms: [],
      ragHits: [],
      rewrite(query, calls) {
        if (calls.length === 0 && query === '怎么设置账号') return '账号设置';
        return '';
      },
    });
    assert.deepEqual(result.calls, ['账号设置']);
    assert.deepEqual(result.items.map((item) => item.id), ['cors']);
    assert.equal(result.notice, '');
  });

  it('drops an id the skill never returned', () => {
    const result = runVideoSearchTrial({
      query: '怎么设置账号',
      videos: [cors],
      synonyms: [],
      ragHits: [],
      rewrite() {
        return '';
      },
      proposedIds: ['missing'],
    });
    assert.deepEqual(result.items, []);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test cloudfunctions/agent/lib/videoSearchTrial.test.js`

Expected: FAIL，找不到 `./videoSearchTrial`。

- [ ] **Step 3: Write minimal implementation**

`runVideoSearchTrial` 用现网 `searchPublished` 做关键词路。循环调用 `rewrite`，非空则 `findVideos`，最多 3 次。Agent 路的 id 取这些卡片的 id，再与 `proposedIds` 求交；`proposedIds` 缺省时就用卡片 id。RAG 路使用传入的 `ragHits`。三路交给 `mergeThreeLanes`。`notice` 交给 `decideThreeLaneNotice`。返回的 `items` 只含 `id` 和 `title`。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test cloudfunctions/agent/lib/videoSearchTrial.test.js cloudfunctions/search/lib/findVideos.test.js cloudfunctions/search/lib/threeLaneNotice.test.js`

Expected: PASS。`calls` 为 `['账号设置']`，`items[0].id` 为 `cors`。

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/agent/lib/videoSearchTrial.js cloudfunctions/agent/lib/videoSearchTrial.test.js
git commit -m "$(cat <<'EOF'
test(agent): 用替身召回验证账号设置能被找到

EOF
)"
```
