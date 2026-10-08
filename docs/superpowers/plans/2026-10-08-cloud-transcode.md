# 新上传视频自动转码 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理端保存新视频后，由云托管按现有播放规格自动转码；已经合格的跳过，解不开的失败，转写失败不删掉合格成片。

**Architecture:** `catalog` 只在入队成功后唤醒云托管 `video-ingest`，定时器补唤醒。容器里跑现有 worker 的领取循环，播放规格仍只来自 `playbackProfile.js`。上传接口不按规格拒绝文件。

**Tech Stack:** Node.js 18、`node:test`、ffmpeg、`wx-server-sdk` 的 `callContainer`、微信云托管。

**Spec:** `docs/superpowers/specs/2026-10-08-cloud-transcode-design.md`

## Global Constraints

- 视频：H.264 Main/Baseline、yuv420p、宽度不超过 1280、帧率不超过 30、无 B 帧、最大关键帧间隔不超过 2 秒、moov 位于 mdat 前。
- 音频：无音轨，或 AAC；有音轨时转码为 AAC 128 kbps。
- 转码参数只调用现有 `buildPlaybackFfmpegArgs`，不另写一套。
- 管理端选视频后照常上传，不按编码、profile、帧率或关键帧间隔拒绝。
- 云函数内不运行 ffmpeg。云托管最大实例数 1，进程内同时只有一个领取循环。
- `ADMIN_PIN`、云密钥不进仓库、镜像和小程序。
- 不改播放页、临时链、小程序包，不自动上架，不重转已上架且未换片的记录。
- 源码注释和 commit message 不写本地文档编号。
- 实现分支从 `dev` 迁出 `dev-cloud-transcode`。本计划和设计说明目前在 `dev-playback-normalize` 的未提交文件里，迁分支时只带走这两份文档，留下 `cloudfunctions/playbackmigrate/`。

---

### Task 1: 转写失败仍保留合格播放文件

**Files:**
- Modify: `scripts/video-ingest/lib/workerLoop.js`
- Test: `scripts/video-ingest/lib/workerLoop.test.js`

**Interfaces:**
- Consumes: `runOnce` 现有依赖 `catalog.complete`、`transcribe`、`deleteCloudFiles`
- Produces: 播放检查已合格且转写抛错时，`complete` 载荷为 `outcome: 'ready'`、`asr: 'failed'`、`errorMessage: '转写失败，播放文件已更新'`，返回值 `'processed'`；若有 `uploadedFileId`，删除的是领取时的原 `videoFileId`，不是新文件

- [ ] **Step 1: 改失败断言为保留成片**

把 `Python 转写超时时回写 ASR_FAILED 且不生成简介` 的断言改成：

```js
assert.equal(await runOnce(deps), 'processed');
assert.equal(completes[0].outcome, 'ready');
assert.equal(completes[0].asr, 'failed');
assert.equal(completes[0].errorMessage, '转写失败，播放文件已更新');
assert.equal(Object.hasOwn(completes[0], 'intro'), false);
assert.equal(Object.hasOwn(completes[0], 'errorCode'), false);
```

再加一条：转码上传后的转写失败不删新文件。

```js
it('转写失败时保留已上传的合格文件并删除原文件', async () => {
  const deletedFileIds = [];
  let probes = 0;
  const { deps, completes } = createDeps({
    probeMedia: async () => {
      probes += 1;
      if (probes === 1) {
        return {
          hasAudio: true,
          durationSec: 3,
          needsTranscode: true,
          playback: playback({ compliant: false }),
        };
      }
      return {
        hasAudio: true,
        durationSec: 3,
        needsTranscode: false,
        playback: playback(),
      };
    },
    transcodeIfNeeded: async () => ({
      path: '/tmp/a-transcoded.mp4',
      uploadedFileId: 'cloud://transcoded',
    }),
    transcribe: async () => {
      throw new Error('asr down');
    },
    deleteCloudFiles: async (fileIds) => deletedFileIds.push(...fileIds),
  });

  assert.equal(await runOnce(deps), 'processed');
  assert.equal(completes[0].transcodedVideoFileId, 'cloud://transcoded');
  assert.deepEqual(deletedFileIds, ['cloud://v']);
});
```

领取任务的原文件 ID 是 `claimedJob()` 里的 `cloud://v`。第二次 `probeMedia` 必须返回合格结果，否则会在转写之前按转码失败删掉新文件。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test scripts/video-ingest/lib/workerLoop.test.js`

Expected: 转写超时用例失败，因为现在回写的是 `outcome: 'failed'`、`errorCode: 'ASR_FAILED'`。

- [ ] **Step 3: 转写失败改走 ready 回写**

在 `workerLoop.js` 里，转写抛错或 `transcription.ok !== true` 时，不要调用 `failPrepared('ASR_FAILED')`。改为：

```js
return completePrepared({
  ...jobIdentity(claimed),
  outcome: 'ready',
  asr: 'failed',
  errorMessage: '转写失败，播放文件已更新',
  ...mediaPayload(probe),
  ...transcoded,
});
```

`resolveAutoIntro` 抛错仍走 `failPrepared('INTERNAL')`。下载失败、转码失败、二次检查失败、ffprobe 抛错保持原样。无音轨仍是 `asr: 'skipped'`。

- [ ] **Step 4: 再跑测试**

Run: `node --test scripts/video-ingest/lib/workerLoop.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/video-ingest/lib/workerLoop.js scripts/video-ingest/lib/workerLoop.test.js
git commit -m "$(cat <<'EOF'
fix(video-ingest): 转写失败时保留已合格的播放文件

EOF
)"
```

---

### Task 2: ready 且转写失败时留下给管理端看的短句

**Files:**
- Modify: `cloudfunctions/catalog/lib/videoIngest.js`
- Test: `cloudfunctions/catalog/lib/videoIngest.test.js`

**Interfaces:**
- Consumes: `planWorkerComplete({ prevIngest, prevIntro, prevIntroSource, complete, now })`
- Produces: `outcome === 'ready' && asr === 'failed'` 时 `ingest.phase === 'ready'`、`ingest.asr === 'failed'`、`ingest.errorCode === ''`、`ingest.errorMessage` 为完成载荷里的短句；不改 intro

- [ ] **Step 1: 写失败测试**

在 `planWorkerComplete` 的 describe 里加：

```js
it('keeps the asr failure message when playback is ready', () => {
  const out = planWorkerComplete({
    prevIngest: base,
    prevIntro: PLACEHOLDER_INTRO,
    prevIntroSource: 'placeholder',
    complete: {
      mediaRevision: 3,
      outcome: 'ready',
      asr: 'failed',
      errorMessage: '转写失败，播放文件已更新',
    },
    now: 9,
  });
  assert.equal(out.ingest.phase, 'ready');
  assert.equal(out.ingest.asr, 'failed');
  assert.equal(out.ingest.errorCode, '');
  assert.equal(out.ingest.errorMessage, '转写失败，播放文件已更新');
  assert.equal(out.applyIntro, false);
  assert.equal(out.intro, PLACEHOLDER_INTRO);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test cloudfunctions/catalog/lib/videoIngest.test.js`

Expected: FAIL，因为 ready 分支把 `errorMessage` 清成空字符串。

- [ ] **Step 3: 只在转写失败的 ready 回写里保留短句**

`planWorkerComplete` 的 ready 分支改为：

```js
ingest.phase = 'ready';
ingest.asr = complete.asr || 'ready';
ingest.errorCode = '';
ingest.errorMessage =
  ingest.asr === 'failed' && typeof complete.errorMessage === 'string'
    ? complete.errorMessage
    : '';
ingest.finishedAt = now;
```

`outcome === 'failed'` 的分支不动。

- [ ] **Step 4: 再跑测试**

Run: `node --test cloudfunctions/catalog/lib/videoIngest.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/catalog/lib/videoIngest.js cloudfunctions/catalog/lib/videoIngest.test.js
git commit -m "$(cat <<'EOF'
fix(catalog): 播放已完成但转写失败时保留提示

EOF
)"
```

---

### Task 3: 编辑页提示手写简介

**Files:**
- Modify: `miniprogram/pages/admin/edit/edit.js`
- Test: `miniprogram/pages/admin/edit/edit.test.js`

**Interfaces:**
- Consumes: `deriveVideoUi` 已有的 `phase`、`asr`
- Produces: `phase === 'ready' && asr === 'failed'` 时 `ingestHint === '转写失败，播放文件已更新，请手写简介后再上架'`；`canPublish` 仍按现有「ready、文件已处理、playback.compliant」计算

- [ ] **Step 1: 写失败测试**

```js
it('asks for a handwritten intro when transcription failed after playback was ready', () => {
  const data = apply(video({
    ingest: {
      phase: 'ready',
      videoFileId: 'cloud://processed',
      asr: 'failed',
      introSource: 'placeholder',
    },
  }));
  assert.equal(data.ingestHint, '转写失败，播放文件已更新，请手写简介后再上架');
  assert.equal(data.canPublish, true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test miniprogram/pages/admin/edit/edit.test.js`

Expected: FAIL，`ingestHint` 现在是「待核对后上架」。

- [ ] **Step 3: 在 ready 分支里先判断转写失败**

`edit.js` 的 `phase === 'ready'` 分支，在 `asr === 'skipped'` 之前加：

```js
if (asr === 'failed') {
  ingestHint = '转写失败，播放文件已更新，请手写简介后再上架';
} else if (asr === 'skipped') {
  ingestHint = '无音轨，已跳过转写';
} else if (asr === 'ready' && introSource === 'placeholder') {
  ingestHint = '字幕已出，简介需手写';
} else {
  ingestHint = '待核对后上架';
}
```

列表页 `videos.js` 的 `ingestLabel` 不改，ready 仍显示「待核对」。

- [ ] **Step 4: 再跑测试**

Run: `node --test miniprogram/pages/admin/edit/edit.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add miniprogram/pages/admin/edit/edit.js miniprogram/pages/admin/edit/edit.test.js
git commit -m "$(cat <<'EOF'
fix(admin): 转写失败时提示手写简介后再上架

EOF
)"
```

---

### Task 4: 入队后唤醒云托管，叫不醒也不让保存失败

**Files:**
- Create: `cloudfunctions/catalog/lib/wakeVideoIngest.js`
- Create: `cloudfunctions/catalog/lib/wakeVideoIngest.test.js`
- Modify: `cloudfunctions/catalog/lib/videoIngestActions.js`
- Modify: `cloudfunctions/catalog/index.js`
- Modify: `cloudfunctions/catalog/config.json`

**Interfaces:**
- Produces: `jobNeedsWake(job, now, timeoutMs) -> boolean`
- Produces: `wakeVideoIngest(callContainer) -> Promise<boolean>`，调用失败返回 `false`
- Produces: `saveVideo` 成功且本次入队时返回值增加 `enqueued: true`；未入队时 `enqueued: false`
- Consumes: `cloud.callContainer({ path: '/run', method: 'POST', header: { 'X-WX-SERVICE': 'video-ingest' }, data: {} })`

- [ ] **Step 1: 写唤醒判断和吞掉异常的测试**

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { jobNeedsWake, wakeVideoIngest } = require('./wakeVideoIngest');

describe('jobNeedsWake', () => {
  it('wakes a queued job and an expired running job only', () => {
    assert.equal(jobNeedsWake({ phase: 'queued', claimedAt: 0 }, 1000, 500), true);
    assert.equal(
      jobNeedsWake({ phase: 'running', claimedAt: 100 }, 1000, 500),
      true,
    );
    assert.equal(
      jobNeedsWake({ phase: 'running', claimedAt: 800 }, 1000, 500),
      false,
    );
    assert.equal(jobNeedsWake({ phase: 'done', claimedAt: 0 }, 1000, 500), false);
  });
});

describe('wakeVideoIngest', () => {
  it('returns false when the container call throws', async () => {
    const woke = await wakeVideoIngest(async () => {
      throw new Error('container down');
    });
    assert.equal(woke, false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test cloudfunctions/catalog/lib/wakeVideoIngest.test.js`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现唤醒**

`wakeVideoIngest.js`：

```js
'use strict';

function jobNeedsWake(job, now, timeoutMs) {
  if (!job) return false;
  if (job.phase === 'queued') return true;
  if (job.phase !== 'running') return false;
  return now - Number(job.claimedAt || 0) >= timeoutMs;
}

async function wakeVideoIngest(callContainer) {
  try {
    await callContainer({
      path: '/run',
      method: 'POST',
      header: { 'X-WX-SERVICE': 'video-ingest' },
      data: {},
    });
    return true;
  } catch {
    return false;
  }
}

module.exports = { jobNeedsWake, wakeVideoIngest };
```

`saveVideo` 在返回 `{ ok: true, id }` 时加上本次事务里的 `planned.enqueue`，字段名 `enqueued`。`index.js` 的 `upsertVideo` 和 `enqueueVideoIngest` 在 `enqueued === true` 后调用 `wakeVideoIngest((options) => cloud.callContainer(options))`，不把唤醒结果写进返回值，也不让异常冒出来。

`config.json` 增加定时触发器，每 5 分钟一次：

```json
"triggers": [
  {
    "name": "wakeVideoIngest",
    "type": "timer",
    "config": "0 */5 * * * * *"
  }
]
```

`exports.main` 在普通 action 之前处理 `event.Type === 'timer'`：查询 `video_ingest_jobs`，用 `jobNeedsWake(job, Date.now(), 30 * 60 * 1000)`，有一条需要唤醒才调用 `wakeVideoIngest`。没有则返回 `{ ok: true, woke: false }`。定时路径不要走管理员票据。

- [ ] **Step 4: 跑 catalog 相关测试**

Run: `node --test cloudfunctions/catalog/lib/wakeVideoIngest.test.js cloudfunctions/catalog/lib/videoIngestActions.test.js`

Expected: PASS。若 `saveVideo` 的现有断言写死了返回字段，把 `enqueued` 补进期望，不要删掉原来的 `ok` 和 `id`。

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/catalog/lib/wakeVideoIngest.js cloudfunctions/catalog/lib/wakeVideoIngest.test.js cloudfunctions/catalog/lib/videoIngestActions.js cloudfunctions/catalog/index.js cloudfunctions/catalog/config.json cloudfunctions/catalog/lib/videoIngestActions.test.js
git commit -m "$(cat <<'EOF'
feat(catalog): 新视频入队后唤醒云托管转码

EOF
)"
```

---

### Task 5: 云托管里同一时间只跑一个领取循环

**Files:**
- Create: `scripts/video-ingest/lib/runQueue.js`
- Create: `scripts/video-ingest/lib/runQueue.test.js`
- Create: `scripts/video-ingest/cloudRunServer.js`
- Create: `services/video-ingest/Dockerfile`

**Interfaces:**
- Produces: `createRunQueue({ runOnce }) -> { run(): Promise<{ started: boolean, outcomes?: string[] }> }`
- `run()` 在已有循环时立刻 `{ started: false }`，不调用第二次 `runOnce`
- 空闲时循环 `runOnce`，直到返回 `'idle'`，再返回 `{ started: true, outcomes }`
- HTTP `POST /run` 等待这一轮 `run()` 结束，响应 JSON `{ ok: true, started }`

- [ ] **Step 1: 写单飞测试**

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createRunQueue } = require('./runQueue');

describe('createRunQueue', () => {
  it('does not start a second loop while one is running', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const queue = createRunQueue({
      runOnce: async () => {
        calls += 1;
        if (calls === 1) {
          await gate;
          return 'processed';
        }
        return 'idle';
      },
    });
    const first = queue.run();
    const second = await queue.run();
    assert.deepEqual(second, { started: false });
    release();
    const finished = await first;
    assert.equal(finished.started, true);
    assert.deepEqual(finished.outcomes, ['processed', 'idle']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test scripts/video-ingest/lib/runQueue.test.js`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现队列和镜像**

`runQueue.js` 用一个 `active` Promise 当锁。第一次 `run` 创建循环；循环里的 `await runOnce()` 结束前，后来的 `run` 看到 `active` 就返回 `{ started: false }`。循环在 `finally` 里把 `active` 置空。

`cloudRunServer.js` 只监听 `POST /run`，调用 `createRunQueue` 包住现有 `runOnce`。`runOnce` 的依赖沿用 `worker.js` 里的 `createJobDependencies`：把它从 `worker.js` 导出，不复制转码参数。容器环境变量仍是 `TCB_ENV_ID`、`TCB_SECRET_ID`、`TCB_SECRET_KEY`、`ADMIN_PIN`，由云托管控制台注入。缺任一项时 `/run` 返回 500 和 `{ ok: false, code: 'NO_CREDENTIALS' }`，正文不带变量值。

`VIDEO_INGEST_RESIDENT=1` 时，进程启动后立刻 `run()` 一次，之后仍接受 `/run`。默认不设置这个变量。

`services/video-ingest/Dockerfile` 以仓库根为构建上下文：

```dockerfile
FROM node:20-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY scripts/video-ingest/package.json scripts/video-ingest/package-lock.json ./
RUN npm ci --omit=dev
COPY scripts/video-ingest ./
ENV PORT=80
EXPOSE 80
CMD ["node", "cloudRunServer.js"]
```

镜像不安装 Python，不复制转写模型。

部署时把云托管请求超时设为控制台允许的最大值，最小实例 0，最大实例 1，关闭公网。环境变量 `FFMPEG_TIMEOUT_MS` 设为请求超时减 60000 毫秒，并在 `worker.js` 读取它，缺省仍是现在的 30 分钟。若控制台最大请求超时小于 15 分钟，改为最小实例 1，并设置 `VIDEO_INGEST_RESIDENT=1`。不要再加别的调度方式。

- [ ] **Step 4: 跑队列测试**

Run: `node --test scripts/video-ingest/lib/runQueue.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/video-ingest/lib/runQueue.js scripts/video-ingest/lib/runQueue.test.js scripts/video-ingest/cloudRunServer.js scripts/video-ingest/worker.js services/video-ingest/Dockerfile
git commit -m "$(cat <<'EOF'
feat(video-ingest): 云托管单实例领取转码队列

EOF
)"
```
