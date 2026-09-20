# 运营上传后自动填写讲解草稿 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 运营在品牌下只上传讲解视频后，系统异步填字幕与步骤简介；人改完再上架。C 端生命周期与处理进度分开。

**Architecture:** `videos.ingest` 给人看；`video_ingest_jobs` 只给 worker 抢锁。云函数入队并回写，不跑 ASR。Worker 在云函数外下载、转写、规则生成 intro，再调用 `completeVideoIngest`。管理端表单不提交 `ingest` / `transcriptSegments`。

**Tech Stack:** 微信云开发 `catalog`、Node.js CommonJS、`node:test`、现有 `scripts/video-ingest`（ffmpeg、faster-whisper）、管理端小程序页。

## Global Constraints

- 功能分支：`dev-video-ops-ingest`（从已含分段字幕保存能力的分支迁出，通常是合入后的 `dev`，或当前的 `dev-video-kb-ingest`）。不得在 `dev` / `main` 直接开发。
- 不调用 `publishVideo`。`排队` / `running` 禁止上架。
- 不把视频、音频、关键帧发给云端多模态 API。
- 密钥、`ADMIN_PIN`、环境 ID、本地绝对路径不得写入仓库或 `videos` / 任务表。
- `transcriptSegments` 仍是口播事实源；`transcript` / `searchBlob` 保存时派生。
- 不自动猜 `tags` / `brandId`；不填 `searchAbstract` / `entities`。
- 运营改过的 intro（`introSource=human`）worker 不得覆盖。
- C 端 `publicVideo` / `getVideo` 不得返回 `ingest`。
- 占位简介常量：`讲解处理中，完成后请核对简介。`
- 失败码仅 `DOWNLOAD_FAILED` | `TRANSCODE_FAILED` | `ASR_FAILED` | `INTERNAL`。无音轨是 `asr=skipped` 且 `phase=ready`，不是失败。intro 取证失败保持占位，`phase=ready`，`asr=ready`。
- 无真实云密钥时单测不打云。

---



### Task 1: `videos.ingest` 纯函数

**Files:**

- Create: `cloudfunctions/catalog/lib/videoIngest.js`
- Create: `cloudfunctions/catalog/lib/videoIngest.test.js`

**Interfaces:**

- Consumes: 无
- Produces:
  - `PLACEHOLDER_INTRO` = `'讲解处理中，完成后请核对简介。'`
  - `CLAIM_TIMEOUT_MS` = `30 * 60 * 1000`
  - `normalizeIngest(raw)` → 缺省 `{ phase: 'idle', mediaRevision: 0, videoFileId: '', asr: 'pending', introSource: 'placeholder', errorCode: '', errorMessage: '', queuedAt: 0, startedAt: 0, finishedAt: 0, attempt: 0 }`
  - `isIngestBusy(ingest)` → `phase` 为 `排队` 或 `running`
  - `planAdminSave({ prevData, nextVideoFileId, nextIntro, now })` → `{ ingest, enqueue: boolean, clearTranscript: boolean }`
  - `planWorkerComplete({ prevIngest, prevIntro, prevIntroSource, complete, now })` → `{ ingest, intro, applyIntro: boolean }` 或抛 `BAD_INPUT`

- [ ] **Step 1: Write failing tests**

```js
'use strict';

const { describe, 它 } = require('node:test');
const assert = require('node:assert/strict');
const {
  PLACEHOLDER_INTRO,
  normalizeIngest,
  isIngestBusy,
  planAdminSave,
  planWorkerComplete,
} = require('./videoIngest');

describe('normalizeIngest', () => {
  它('treats missing ingest as idle', () => {
    const ingest = normalizeIngest(undefined);
    assert.equal(ingest.phase, 'idle');
    assert.equal(ingest.mediaRevision, 0);
    assert.equal(PLACEHOLDER_INTRO, '讲解处理中，完成后请核对简介。');
  });
});

describe('planAdminSave', () => {
  它('enqueues and clears transcript when videoFileId first appears', () => {
    const out = planAdminSave({
      prevData: null,
      nextVideoFileId: 'cloud://v1',
      nextIntro: PLACEHOLDER_INTRO,
      now: 1000,
    });
    assert.equal(out.enqueue, true);
    assert.equal(out.clearTranscript, true);
    assert.equal(out.ingest.phase, '排队');
    assert.equal(out.ingest.mediaRevision, 1);
    assert.equal(out.ingest.videoFileId, 'cloud://v1');
    assert.equal(out.ingest.asr, 'pending');
    assert.equal(out.ingest.introSource, 'placeholder');
    assert.equal(out.ingest.queuedAt, 1000);
    assert.equal(out.ingest.attempt, 1);
  });

  它('does not enqueue when videoFileId is unchanged', () => {
    const prev = {
      videoFileId: 'cloud://v1',
      ingest: {
        phase: 'ready',
        mediaRevision: 2,
        videoFileId: 'cloud://v1',
        asr: 'ready',
        introSource: '自动(auto)',
        errorCode: '',
        errorMessage: '',
        queuedAt: 1,
        startedAt: 2,
        finishedAt: 3,
        attempt: 1,
      },
    };
    const out = planAdminSave({
      prevData: prev,
      nextVideoFileId: 'cloud://v1',
      nextIntro: '点击测量。',
      now: 2000,
    });
    assert.equal(out.enqueue, false);
    assert.equal(out.clearTranscript, false);
    assert.equal(out.ingest.phase, 'ready');
    assert.equal(out.ingest.introSource, 'human');
    assert.equal(out.ingest.mediaRevision, 2);
  });

  它('marks human intro even while running, without bumping revision', () => {
    const prev = {
      videoFileId: 'cloud://v1',
      intro: PLACEHOLDER_INTRO,
      ingest: {
        phase: 'running',
        mediaRevision: 1,
        videoFileId: 'cloud://v1',
        asr: 'pending',
        introSource: 'placeholder',
        errorCode: '',
        errorMessage: '',
        queuedAt: 1,
        startedAt: 2,
        finishedAt: 0,
        attempt: 1,
      },
    };
    const out = planAdminSave({
      prevData: prev,
      nextVideoFileId: 'cloud://v1',
      nextIntro: '人手写的步骤。',
      now: 3000,
    });
    assert.equal(out.enqueue, false);
    assert.equal(out.ingest.phase, 'running');
    assert.equal(out.ingest.introSource, 'human');
  });

  它('replacing the file bumps revision, clears transcript, and requeues', () => {
    const prev = {
      videoFileId: 'cloud://old',
      ingest: {
        phase: 'ready',
        mediaRevision: 1,
        videoFileId: 'cloud://old',
        asr: 'ready',
        introSource: '自动(auto)',
        errorCode: '',
        errorMessage: '',
        queuedAt: 1,
        startedAt: 2,
        finishedAt: 3,
        attempt: 1,
      },
    };
    const out = planAdminSave({
      prevData: prev,
      nextVideoFileId: 'cloud://new',
      nextIntro: '旧简介',
      now: 4000,
    });
    assert.equal(out.enqueue, true);
    assert.equal(out.clearTranscript, true);
    assert.equal(out.ingest.mediaRevision, 2);
    assert.equal(out.ingest.videoFileId, 'cloud://new');
    assert.equal(out.ingest.phase, '排队');
    assert.equal(out.ingest.asr, 'pending');
    assert.equal(out.ingest.introSource, 'placeholder');
  });
});

describe('isIngestBusy', () => {
  它('is busy only for queued and running', () => {
    assert.equal(isIngestBusy({ phase: '排队' }), true);
    assert.equal(isIngestBusy({ phase: 'running' }), true);
    assert.equal(isIngestBusy({ phase: 'ready' }), false);
    assert.equal(isIngestBusy({ phase: 'idle' }), false);
    assert.equal(isIngestBusy(undefined), false);
  });
});

describe('planWorkerComplete', () => {
  const base = {
    phase: 'running',
    mediaRevision: 3,
    videoFileId: 'cloud://v1',
    asr: 'pending',
    introSource: 'placeholder',
    errorCode: '',
    errorMessage: '',
    queuedAt: 1,
    startedAt: 2,
    finishedAt: 0,
    attempt: 1,
  };

  它('rejects stale mediaRevision', () => {
    assert.throws(
      () =>
        planWorkerComplete({
          prevIngest: base,
          prevIntro: PLACEHOLDER_INTRO,
          prevIntroSource: 'placeholder',
          完成: { mediaRevision: 2, outcome: 'ready', asr: 'ready' },
          now: 5,
        }),
      (err) => err.代码 === 'BAD_INPUT',
    );
  });

  它('skips intro when introSource is human', () => {
    const out = planWorkerComplete({
      prevIngest: { ...base, introSource: 'human' },
      prevIntro: '人手写。',
      prevIntroSource: 'human',
      完成: {
        mediaRevision: 3,
        outcome: 'ready',
        asr: 'ready',
        intro: '自动生成应被忽略。',
      },
      now: 9,
    });
    assert.equal(out.applyIntro, false);
    assert.equal(out.intro, '人手写。');
    assert.equal(out.ingest.introSource, 'human');
    assert.equal(out.ingest.phase, 'ready');
    assert.equal(out.ingest.asr, 'ready');
  });

  它('keeps placeholder when complete omits intro (ungrounded)', () => {
    const out = planWorkerComplete({
      prevIngest: base,
      prevIntro: PLACEHOLDER_INTRO,
      prevIntroSource: 'placeholder',
      完成: { mediaRevision: 3, outcome: 'ready', asr: 'ready' },
      now: 9,
    });
    assert.equal(out.applyIntro, false);
    assert.equal(out.intro, PLACEHOLDER_INTRO);
    assert.equal(out.ingest.introSource, 'placeholder');
    assert.equal(out.ingest.phase, 'ready');
  });

  它('applies auto intro when allowed', () => {
    const out = planWorkerComplete({
      prevIngest: base,
      prevIntro: PLACEHOLDER_INTRO,
      prevIntroSource: 'placeholder',
      完成: {
        mediaRevision: 3,
        outcome: 'ready',
        asr: 'ready',
        intro: '点击测量。',
      },
      now: 9,
    });
    assert.equal(out.applyIntro, true);
    assert.equal(out.intro, '点击测量。');
    assert.equal(out.ingest.introSource, '自动(auto)');
  });

  它('records failed outcome without writing intro', () => {
    const out = planWorkerComplete({
      prevIngest: base,
      prevIntro: PLACEHOLDER_INTRO,
      prevIntroSource: 'placeholder',
      完成: {
        mediaRevision: 3,
        outcome: 'failed',
        asr: 'failed',
        errorCode: 'ASR_FAILED',
        errorMessage: '转写失败',
      },
      now: 9,
    });
    assert.equal(out.applyIntro, false);
    assert.equal(out.ingest.phase, 'failed');
    assert.equal(out.ingest.errorCode, 'ASR_FAILED');
    assert.equal(out.ingest.asr, 'failed');
  });

  它('treats skipped asr as ready', () => {
    const out = planWorkerComplete({
      prevIngest: base,
      prevIntro: PLACEHOLDER_INTRO,
      prevIntroSource: 'placeholder',
      完成: { mediaRevision: 3, outcome: 'ready', asr: 'skipped' },
      now: 9,
    });
    assert.equal(out.ingest.phase, 'ready');
    assert.equal(out.ingest.asr, 'skipped');
  });
});
```



另测：`nextIntro` 与上一版相同且非占位、`introSource` 已是 `自动(auto)` 时保持 `自动(auto)`；仅当 intro 字符串相对 `prevData.intro` 发生变化且新值不是 `PLACEHOLDER_INTRO` 时才标 `human`。无 `videoFileId` 的保存：`enqueue=false`，`phase` 保持 `idle`。`errorCode` 只允许四个失败码，非法码抛 `BAD_INPUT`。

- [ ] **Step 2: Run and verify RED**

```bash
node --test cloudfunctions/catalog/lib/videoIngest.test.js
```

Expected: FAIL because `./videoIngest` does not exist.

- [ ] **Step 3: Implement** `videoIngest.js`

`planAdminSave`：比较 `nextVideoFileId` 与 `prevData.videoFileId`（新建时旧值为空）。文件变化则 `mediaRevision = prev+1`（idle 的 0 变成 1）、清空错误字段、`phase=queued`、`asr=pending`、`introSource=placeholder`、`attempt += 1`、`queuedAt=now`。文件未变则从 `normalizeIngest(prev.ingest)` 出发，只按 intro 规则改 `introSource`。

`planWorkerComplete`：`complete.mediaRevision` 必须等于 `prevIngest.mediaRevision`。`outcome === 'failed'` 时 `phase=failed`，必须带允许的 `errorCode`。成功则 `phase=ready`，`finishedAt=now`，清空 `errorCode`/`errorMessage`。仅当 `prevIntroSource !== 'human'` 且 `complete.intro` 为非空字符串时 `applyIntro=true` 且 `introSource=auto`。

- [ ] **Step 4: Run tests PASS**

```bash
node --test cloudfunctions/catalog/lib/videoIngest.test.js
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/catalog/lib/videoIngest.js cloudfunctions/catalog/lib/videoIngest.test.js
git commit -m "$(cat <<'EOF'
feat(catalog): 增加讲解自动处理状态机

把 C 端上下架与转写进度拆开，换片清字幕并入队，运营改过的简介禁止被 worker 覆盖。
EOF
)"
```

---



### Task 2: 处理中禁止上架

**Files:**

- Modify: `cloudfunctions/catalog/lib/videoPublishGate.js`
- Modify: `cloudfunctions/catalog/lib/videoPublishGate.test.js`
- Modify: `miniprogram/utils/videoPublishGate.js`

**Interfaces:**

- Consumes: `isIngestBusy` from `./videoIngest`（云函数侧）
- Produces: `assertReadyToPublish` 在 busy 时抛 `BAD_INPUT`，消息 `处理完成前不能上架`

小程序没有云函数模块路径，在 `miniprogram/utils/videoPublishGate.js` **复制** `isIngestBusy` 判定（只看 `doc.ingest.phase` 是否为 `排队`/`running`），不要从 `cloudfunctions/` require。

- [ ] **Step 1: Write failing tests**

在 `videoPublishGate.test.js` 增加：

```js
它('rejects publish while ingest is queued or running', () => {
  const base = {
    title: '主机架设',
    intro: '对中讲解',
    brandId: 'b1',
    coverFileId: 'cloud://c',
    videoFileId: 'cloud://v',
  };
  assert.equal(isReadyToPublish({ ...base, ingest: { phase: '排队' } }), false);
  assert.equal(isReadyToPublish({ ...base, ingest: { phase: 'running' } }), false);
  assert.equal(isReadyToPublish({ ...base, ingest: { phase: 'ready' } }), true);
  assert.equal(isReadyToPublish({ ...base, ingest: { phase: 'failed' } }), true);
  assert.equal(isReadyToPublish(base), true);
});
```

- [ ] **Step 2: Run RED**

```bash
node --test cloudfunctions/catalog/lib/videoPublishGate.test.js
```

Expected: FAIL on the new assertion (`isReadyToPublish` still true for queued).

- [ ] **Step 3: Implement**

`assertReadyToPublish` 在现有封面/视频检查之后：

```js
const { isIngestBusy } = require('./videoIngest');
// ...
if (isIngestBusy(doc && doc.ingest)) {
  fail('处理完成前不能上架');
}
```

小程序文件同样在封面检查后：

```js
const phase = doc && doc.ingest && doc.ingest.phase;
if (phase === '排队' || phase === 'running') {
  fail('处理完成前不能上架');
}
```

- [ ] **Step 4: Run PASS**

```bash
node --test cloudfunctions/catalog/lib/videoPublishGate.test.js
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/catalog/lib/videoPublishGate.js cloudfunctions/catalog/lib/videoPublishGate.test.js miniprogram/utils/videoPublishGate.js
git commit -m "$(cat <<'EOF'
fix(catalog): 转写排队或进行中禁止上架

避免处理中的占位简介被发布到 C 端。
EOF
)"
```

---



### Task 3: C 端不泄漏 `ingest`；管理端列表带上它

**Files:**

- Create: `cloudfunctions/catalog/lib/publicVideo.js`
- Create: `cloudfunctions/catalog/lib/publicVideo.test.js`
- Modify: `cloudfunctions/catalog/index.js`（`publicVideo` 改为引用 lib；`adminListVideos` 的 `field` 增加 `ingest: true`）

**Interfaces:**

- Consumes: 视频文档
- Produces: `publicVideo(doc)` 白名单，无 `ingest`、无 `transcriptSegments`

- [ ] **Step 1: Write failing test**

```js
它('omits ingest and transcript from the public projection', () => {
  const video = publicVideo({
    _id: '1',
    title: 't',
    intro: 'i',
    brandId: 'b',
    brandName: '南',
    status: 'published',
    ingest: { phase: 'ready' },
    transcriptSegments: [{ startSec: 0, endSec: 1, 文本: '密' }],
    transcript: '密',
  });
  assert.equal(video.ingest, undefined);
  assert.equal(video.transcriptSegments, undefined);
  assert.equal(video.transcript, undefined);
  assert.equal(video.title, 't');
});
```

把现网 `index.js` 里 `publicVideo` 的字段列表原样搬进 lib（含 `searchAbstract` / `entities` / `publishedAt` 等现有键），不要借机删字段。

- [ ] **Step 2: Run RED**

```bash
node --test cloudfunctions/catalog/lib/publicVideo.test.js
```

Expected: FAIL because module missing.

- [ ] **Step 3: Extract and wire**

`index.js`：`const { publicVideo } = require('./lib/publicVideo');` 删除本地函数。

`adminListVideos` 的 `.field({...})` 增加 `ingest: true`。不要把 `ingest` 加进 `search` 的 published 投影。

- [ ] **Step 4: Run PASS**

```bash
node --test cloudfunctions/catalog/lib/publicVideo.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/catalog/lib/publicVideo.js cloudfunctions/catalog/lib/publicVideo.test.js cloudfunctions/catalog/index.js
git commit -m "$(cat <<'EOF'
feat(catalog): C 端视频投影去掉处理状态

管理端列表改为带上 ingest，播放与搜索仍只用白名单字段。
EOF
)"
```

---



### Task 4: 任务表抢锁纯函数 + 集合登记

**Files:**

- Create: `cloudfunctions/catalog/lib/videoIngestJobs.js`
- Create: `cloudfunctions/catalog/lib/videoIngestJobs.test.js`
- Modify: `cloudfunctions/catalog/lib/ensureCollections.js`
- Modify: `cloudfunctions/catalog/lib/ensureCollections.test.js`

**Interfaces:**

- Consumes: `CLAIM_TIMEOUT_MS` from `videoIngest.js`
- Produces:
  - `canEnqueue(phase)` → `排队`/`running` 为 false，其余 true
  - `createJobRecord({ videoId, mediaRevision, now })` → `{ videoId, mediaRevision, phase: 'queued', claimedAt: 0, claimedBy: '', createdAt: now, updatedAt: now }`
  - `claimJobRecord({ job, workerId, now, timeoutMs })` → 若 `排队`，或 `running` 且 `now - claimedAt >= timeoutMs`，则 `{ ...job, phase: 'running', claimedAt: now, claimedBy: workerId, updatedAt: now }`；否则返回 `null`
  - `finishJobRecord({ job, now, phase })` 其中 `phase` 仅 `done`|`dead`

- [ ] **Step 1: Write failing tests**

覆盖：idle/ready/failed 可入队；queued 不可；fresh running 不可领；过期 running 可被另一 `workerId` 领；`claimJobRecord` 对 `done` 返回 `null`。

`ensureCollections` 现有测试把 `CATALOG_COLLECTIONS` 写成固定数组，改为期望末尾增加 `'video_ingest_jobs'`，并改测试标题。

- [ ] **Step 2: Run RED**

```bash
node --test cloudfunctions/catalog/lib/videoIngestJobs.test.js cloudfunctions/catalog/lib/ensureCollections.test.js
```

Expected: jobs 模块缺失；collections 数组长度断言失败。

- [ ] **Step 3: Implement**

`ensureCollections.js` 的 `CATALOG_COLLECTIONS` 追加 `'video_ingest_jobs'`。

- [ ] **Step 4: Run PASS**

```bash
node --test cloudfunctions/catalog/lib/videoIngestJobs.test.js cloudfunctions/catalog/lib/ensureCollections.test.js
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/catalog/lib/videoIngestJobs.js cloudfunctions/catalog/lib/videoIngestJobs.test.js cloudfunctions/catalog/lib/ensureCollections.js cloudfunctions/catalog/lib/ensureCollections.test.js
git commit -m "$(cat <<'EOF'
feat(catalog): 登记讲解处理任务表并规定抢锁规则

任务表只负责领取，对人展示仍以 videos.ingest 为准。
EOF
)"
```

---



### Task 5: catalog 入队、领取、回写

**Files:**

- Modify: `cloudfunctions/catalog/index.js`
- Create: `cloudfunctions/catalog/lib/videoIngestActions.test.js`（测从 index 抽出的薄封装，见下）

若 `index.js` 难以单测（依赖 `wx-server-sdk`），把编排放到：

- Create: `cloudfunctions/catalog/lib/videoIngestActions.js`

**Interfaces:**

- Consumes: `planAdminSave`、`planWorkerComplete`、`canEnqueue`、`createJobRecord`、`claimJobRecord`、`finishJobRecord`、`resolveVideoKnowledge`、`normalizeVideoMedia`
- Produces:
  - `buildUpsertIngestPatch({ prevData, nextVideoFileId, nextIntro, now })` 即 Task 1 的 `planAdminSave` 再附带：`clearTranscript` 时 event 侧应把 `transcriptSegments` 变成 `[]`（在 `upsertVideo` 里：若 `clearTranscript`，调用 `resolveVideoKnowledge` 前把 `event.transcriptSegments = []`，从而覆盖旧分段）
  - catalog `action`：`enqueueVideoIngest`、`claimVideoIngest`、`completeVideoIngest`

`upsertVideo` 必须 **忽略** `event.ingest`，但继续接受并校验 `event.transcriptSegments`，以兼容现有受控批量导入脚本；普通管理端保存本来不带该键，沿用 `resolveVideoKnowledge` 现网行为。`clearTranscript` 时由服务端强制写入空数组，优先于调用方分段。

`enqueueVideoIngest({ ticket, id })`：读视频，`canEnqueue(ingest.phase)` 否则 `BAD_INPUT`「正在处理」；然后按「同一 fileId 再跑」处理：`mediaRevision` 不变，`phase=queued`，`asr=pending`，`attempt++`，插入新 job。`排队`/`running` 拒绝。`idle` 且无 `videoFileId` 拒绝。

`claimVideoIngest({ ticket, workerId })`：查询 `phase==queued` 的一条；没有则查过期 `running`。用 `claimJobRecord`。成功后把对应 `videos.ingest.phase` 设为 `running`，`startedAt=now`，`claimedBy` 只写任务表。返回 `{ ok, job, videoId, mediaRevision, videoFileId }`。无任务 `{ ok: true, job: null }`。

`completeVideoIngest({ ticket, videoId, mediaRevision, outcome, asr, errorCode, errorMessage, intro, transcriptSegments, durationSec, media, coverFileId, transcodedVideoFileId })`：读视频；`planWorkerComplete`；字幕仅在 `outcome==='ready' && (asr==='ready')` 时经 `resolveVideoKnowledge` 写入；`asr==='skipped' || failed` 且非 human 路径不要用假分段。`coverFileId` 仅当库中封面为空且参数非空时写入。`transcodedVideoFileId` 若有：更新 `videoFileId` 与 `ingest.videoFileId`，**不** `mediaRevision++`、**不** 再入队（与运营换片区分）。对应 job 标 `done` 或 `dead`（failed → job `done` 仍可，人看 ingest.failed）。修订不一致：`BAD_INPUT`，不改库。

普通 `upsertVideo` 在算出 `planAdminSave` 且 `enqueue===true` 时 `db.collection('video_ingest_jobs').add(createJobRecord(...))`。

- [ ] **Step 1: Write failing tests for** `videoIngestActions.js`

用内存假 DB：

```js
它('clears transcript when admin replaces the file', () => {
  const prevData = {
    videoFileId: 'cloud://old',
    intro: '旧',
    transcriptSegments: [{ startSec: 0, endSec: 1, 文本: '旧词' }],
    transcript: '旧词',
    ingest: { phase: 'ready', mediaRevision: 1, videoFileId: 'cloud://old', asr: 'ready', introSource: '自动(auto)', errorCode: '', errorMessage: '', queuedAt: 1, startedAt: 2, finishedAt: 3, attempt: 1 },
  };
  const patch = buildUpsertIngestPatch({
    prevData,
    nextVideoFileId: 'cloud://new',
    nextIntro: PLACEHOLDER_INTRO,
    now: 10,
  });
  assert.equal(patch.clearTranscript, true);
  assert.equal(patch.ingest.mediaRevision, 2);
});

它('rejects enqueue while busy', () => {
  assert.equal(canEnqueue('排队'), false);
  assert.equal(canEnqueue('failed'), true);
});
```

再测 `applyCompleteToVideo({ prevData, complete, now })`：拼出下一版 payload 的 `ingest`/`intro`/`transcriptSegments` 决策（不碰数据库）。

- [ ] **Step 2: Run RED**

```bash
node --test cloudfunctions/catalog/lib/videoIngestActions.test.js
```

- [ ] **Step 3: Implement actions + wire** `index.js` **dispatch**

`switch` 增加三个 case。函数开头均 `requireAdmin(event.ticket)`。worker 与运营共用管理员票；**不要**新造 PIN 字段进仓库。

`upsertVideo` 在组 payload 时：

```js
const planned = planAdminSave({
  prevData,
  nextVideoFileId: payload.videoFileId,
  nextIntro: intro,
  now: Date.now(),
});
const knowledgeEvent = planned.clearTranscript
  ? Object.assign({}, event, { transcriptSegments: [] })
  : event;
const knowledge = resolveVideoKnowledge({
  event: knowledgeEvent,
  prevData,
  durationSec: mediaMeta.durationSec,
});
payload.ingest = planned.ingest;
```

`planAdminSave` 在换片时应把 intro 的 `introSource` 设为 placeholder，但 **不要**在 upsert 里强行改运营正在保存的 intro 字符串（换片时编辑页可能仍提交旧 intro）。换片只改 ingest；intro 正文仍用 event.intro。若换片且 intro 仍是旧自动稿，允许保留正文，但 `introSource` 按 Task 1：换片重置为 `placeholder`，worker 仍可覆盖。若此时 event.intro 已是人改且不等于旧值，换片分支优先：文件变化时 `introSource=placeholder`（spec：换片清字幕，intro 允许 worker 重写）。人改与换片同时发生：以换片为准，`introSource=placeholder`。

入队 `add` 失败要让 upsert 失败，避免「库已 queued 但无 job」。

- [ ] **Step 4: Run PASS**

```bash
node --test cloudfunctions/catalog/lib/videoIngest.test.js cloudfunctions/catalog/lib/videoIngestActions.test.js cloudfunctions/catalog/lib/videoPublishGate.test.js
```

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/catalog/index.js cloudfunctions/catalog/lib/videoIngestActions.js cloudfunctions/catalog/lib/videoIngestActions.test.js
git commit -m "$(cat <<'EOF'
feat(catalog): 上传后入队并由 worker 回写处理结果

管理端保存不再提交处理状态；换片清空旧字幕。
EOF
)"
```

---



### Task 6: 管理端上传壳与进度展示

**Files:**

- Modify: `miniprogram/pages/admin/edit/edit.js`
- Modify: `miniprogram/pages/admin/edit/edit.wxml`
- Modify: `miniprogram/pages/admin/videos/videos.js`
- Modify: `miniprogram/pages/admin/videos/videos.wxml`

**Interfaces:**

- Consumes: `adminListVideos` 的 `ingest`；`PLACEHOLDER_INTRO` 与云函数相同字符串（在编辑页写死同一常量，避免跨端包）
- Produces: 无标题时上传仍能保存；列表/编辑展示处理文案；busy 时无上架按钮（`isReadyToPublish` 已处理）

- [ ] **Step 1: 编辑页壳字段**

`edit.js` 增加 `ingestPhase`、`ingestHint`、`canRetryIngest`。`applyVideo` 读取 `video.ingest`。

上传前 `ensureSaved`：若 `title` 为空，设为 `讲解` + 本地 `YYYYMMDD-HHmm`；若 `intro` 为空，设为占位常量。不要在上传接口里等转写。

`ingestHint`：


| phase / asr                           | 文案                     |
| ------------------------------------- | ---------------------- |
| queued / running                      | 正在生成字幕和简介              |
| ready + asr ready + placeholder intro | 字幕已出，简介需手写             |
| ready + asr skipped                   | 无音轨，已跳过转写              |
| ready + auto/human                    | 待核对后上架                 |
| failed                                | `errorMessage` 或「处理失败」 |
| idle                                  | 空                      |


`canRetryIngest`：`failed` 或 `ready`。按钮调用 `enqueueVideoIngest`。busy 时禁用上传替换以外的「重新处理」。

简介 `placeholder` 属性在 `introSource==='placeholder'` 时改为「处理完成后将自动填写，也可先手写」。

- [ ] **Step 2: 列表**

`videos.js` 的 `statusLabel` 旁增加 `ingestLabel`（处理中 / 待核对 / 失败 / 无音轨 / 空）。`videos.wxml` 在 `statusLabel` 那一行追加 `ingestLabel`。

`canPublish` 继续用 `isReadyToPublish(item)`（已含 busy）。

- [ ] **Step 3: 手动点选核对**

无法在本仓库对真机小程序做自动 UI 测试。用编辑页常量与 `enqueueVideoIngest` 的 action 名对照 spec。若仓库后续有小程序单测再补；本任务不编造测试框架。

- [ ] **Step 4: Commit**

```bash
git add miniprogram/pages/admin/edit/edit.js miniprogram/pages/admin/edit/edit.wxml miniprogram/pages/admin/videos/videos.js miniprogram/pages/admin/videos/videos.wxml
git commit -m "$(cat <<'EOF'
feat(admin): 上传讲解后展示自动处理进度

空标题和空简介用壳字段占住保存闸门，处理中不出现上架。
EOF
)"
```

---



### Task 7: 由字幕规则生成 intro

**Files:**

- Create: `scripts/video-ingest/lib/autoIntro.js`
- Create: `scripts/video-ingest/lib/autoIntro.test.js`

**Interfaces:**

- Consumes: `validateReviewedIntro` from `./intro.js`（`placeholderIntro` 用 `PLACEHOLDER_INTRO` 字符串，与 catalog 常量一致，在 autoIntro 内再导出一份相同字面量以免脚本依赖云函数路径）
- Produces: `draftIntroFromSegments(transcriptSegments) → string`；`resolveAutoIntro({ transcriptSegments, placeholderIntro }) → { intro, grounded: boolean }`

算法：把各段 `文本` 按 `。！？；` 切开，去空白，按顺序拼接，每步一句，总字数不超过 400（用现有 `validateReviewedIntro` 的长度语义：实现里用 `[...text].length`）。拼完后 `validateReviewedIntro({ intro, transcriptSegments, placeholderIntro, keyframeEvidence: [] })`。`valid===true` 则 `grounded: true`；否则 `intro` 仍为占位、`grounded: false`。无分段或空文本 → 不 grounded。

本任务 **不** 使用关键帧申报；第一期 worker 也不把帧送给模型。关键帧抽取可留在 Task 8 仅作运营本机排查，不写入 intro。

- [ ] **Step 1: Write failing tests**

```js
它('builds a grounded step intro from transcript sentences', () => {
  const segments = [
    { startSec: 0, endSec: 2, 文本: '点击测量' },
    { startSec: 2, endSec: 4, 文本: '保存项目' },
  ];
  const out = resolveAutoIntro({
    transcriptSegments: segments,
    placeholderIntro: '讲解处理中，完成后请核对简介。',
  });
  assert.equal(out.grounded, true);
  assert.match(out.intro, /测量/);
});

它('returns placeholder when there is no transcript', () => {
  const out = resolveAutoIntro({
    transcriptSegments: [],
    placeholderIntro: '讲解处理中，完成后请核对简介。',
  });
  assert.equal(out.grounded, false);
  assert.equal(out.intro, '讲解处理中，完成后请核对简介。');
});
```

再测超 400 字截断后仍能通过取证（截断落在句子边界，不要半句）。

- [ ] **Step 2: Run RED**

```bash
node --test scripts/video-ingest/lib/autoIntro.test.js
```

- [ ] **Step 3: Implement and PASS**

```bash
node --test scripts/video-ingest/lib/autoIntro.test.js scripts/video-ingest/lib/intro.test.js
```

- [ ] **Step 4: Commit**

```bash
git add scripts/video-ingest/lib/autoIntro.js scripts/video-ingest/lib/autoIntro.test.js
git commit -m "$(cat <<'EOF'
feat(ingest): 用字幕句子生成可取证的步骤简介

取证失败则保持占位句，不写没有依据的按钮名。
EOF
)"
```

---



### Task 8: Worker 轮询（假 I/O 单测 + 真脚本）

**Files:**

- Create: `scripts/video-ingest/lib/workerLoop.js`
- Create: `scripts/video-ingest/lib/workerLoop.test.js`
- Create: `scripts/video-ingest/worker.js`
- Modify: `scripts/video-ingest/README.md`（增加 worker 启动方式与环境变量名，不写密钥值）

**Interfaces:**

- Consumes: `claimVideoIngest` / `completeVideoIngest` 由注入的 `catalog` 客户端提供；下载/转码/ASR 由注入函数提供
- Produces: `runOnce(deps) → 'idle' | 'processed' | 'failed'`

```js
async function runOnce({
  catalog,
  workerId,
  downloadVideo,      // (fileId) => localPath
  probeMedia,         // (path) => { hasAudio, videoCodec, audioCodec, durationSec, needsTranscode }
  transcodeIfNeeded,  // (path, probe) => { path, uploadedFileId? }
  transcribe,         // (path) => { ok, segments, skipped }
  resolveAutoIntro,
  placeholderIntro,
  now,
}) {}
```

流程：`claim` → 无 job 返回 `idle` → download 抛错则 complete `DOWNLOAD_FAILED` → probe 无音频则 complete `asr=skipped` outcome ready、不带 intro → 需转码失败 `TRANSCODE_FAILED` → 转码成功则 complete 时带 `transcodedVideoFileId`（同一轮，先不要二次 claim）→ transcribe 失败 `ASR_FAILED` → 成功则 `resolveAutoIntro`；grounded 则 complete 带 intro，否则不带 intro。`INTERNAL` 用于未分类异常，`errorMessage` 用固定中文「处理失败」，不要拼 stack。

`worker.js` 用现有 CloudBase SDK（与 `import.js` 相同环境变量：`TCB_ENV_ID`、`TCB_SECRET_ID`、`TCB_SECRET_KEY`、`ADMIN_PIN`），循环 `runOnce`，空闲 sleep 5s。登录拿 ticket 的方式跟 `import.js` 看齐（读该文件现有 `adminLogin` 调用，不要另发明密钥通道）。

- [ ] **Step 1: Write failing tests with fake catalog**

```js
它('completes skipped when probe has no audio', async () => {
  const completes = [];
  const result = await runOnce({
    catalog: {
      claim: async () => ({
        job: { mediaRevision: 1 },
        videoId: 'vid',
        mediaRevision: 1,
        videoFileId: 'cloud://v',
      }),
      完成: async (payload) => {
        completes.push(payload);
      },
    },
    workerId: 'w1',
    downloadVideo: async () => '/tmp/a.mp4',
    probeMedia: async () => ({
      hasAudio: false,
      videoCodec: 'h264',
      audioCodec: '',
      durationSec: 3,
      needsTranscode: false,
    }),
    transcodeIfNeeded: async () => ({ path: '/tmp/a.mp4' }),
    transcribe: async () => {
      throw new Error('should not transcribe');
    },
    resolveAutoIntro: () => ({ grounded: false, intro: 'x' }),
    placeholderIntro: '讲解处理中，完成后请核对简介。',
    now: 1,
  });
  assert.equal(result, 'processed');
  assert.equal(completes[0].asr, 'skipped');
  assert.equal(completes[0].outcome, 'ready');
});
```

再测 download 失败、ASR 失败、grounded intro 带上 `intro`、claim 空返回 `idle`。

- [ ] **Step 2: Run RED then implement PASS**

```bash
node --test scripts/video-ingest/lib/workerLoop.test.js
```

- [ ] **Step 3:** `worker.js` **胶水**

真实 `transcribe` 调现有 `transcribe.py` 或抽出的 Node 包装；不要把模型文件路径写进 git。README 写：

```bash
# 需本机已配置 TCB_* 与 ADMIN_PIN
node scripts/video-ingest/worker.js
```

没有凭据时脚本以非 0 退出并打印「缺少云开发凭据」，不要在测试里连网。

- [ ] **Step 4: 全量相关测试**

```bash
node --test cloudfunctions/catalog/lib/videoIngest.test.js cloudfunctions/catalog/lib/videoIngestActions.test.js cloudfunctions/catalog/lib/videoIngestJobs.test.js cloudfunctions/catalog/lib/videoPublishGate.test.js cloudfunctions/catalog/lib/publicVideo.test.js cloudfunctions/catalog/lib/ensureCollections.test.js
node --test scripts/video-ingest/lib/autoIntro.test.js scripts/video-ingest/lib/workerLoop.test.js
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/video-ingest/lib/workerLoop.js scripts/video-ingest/lib/workerLoop.test.js scripts/video-ingest/worker.js scripts/video-ingest/README.md
git commit -m "$(cat <<'EOF'
feat(ingest): 增加云函数外的讲解处理 worker

用注入依赖覆盖无音轨和失败路径，避免单测连接真实云存储。
EOF
)"
```

---



## Spec coverage


| Spec                                        | 任务               |
| ------------------------------------------- | ---------------- |
| `videos.ingest` 状态机、换片 revision、human intro | 1、5              |
| 禁止布尔 `processed`                            | 1（只有 phase/asr）  |
| `video_ingest_jobs` 抢锁、超时再领                 | 4、5              |
| 失败码允许列表；无音轨 skipped；intro 取证失败仍 ready       | 1、7、8            |
| 上传壳 + 占位 intro + 仍选品牌                       | 5、6              |
| busy 不上架；不自动 publish                        | 2、6              |
| public 无 ingest                             | 3                |
| 管理端列表/详情/重试                                 | 3、5、6            |
| worker 非云函数、不外发画面                           | 8                |
| 不猜 tags/品牌                                  | 8（worker 不写这些字段） |
| 无密钥单测                                       | 全程假 I/O          |




## 不在本计划

播放页 `video_doc`、search/agent、云端多模态、自动上架、独立 worker PIN、云托管 Dockerfile。