# 讲解视频播放规格与入库预处理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将批量入库、运营上传和存量替换统一到一套小程序播放规格，并安全替换当前 23 条云存储视频。

**Architecture:** `scripts/video-ingest/lib/playbackProfile.js` 是本地媒体检查与转码参数的唯一来源，`preprocess.js` 与 `worker.js` 共同调用。云函数只接受 worker/迁移脚本回写的播放检查结果，并在上架时验证处理状态、文件身份和检查结果；迁移脚本通过专用管理端 action 原子替换文件引用，不走会清字幕的运营换片流程。

**Tech Stack:** Node.js 18、`node:test`、ffprobe、ffmpeg、微信云开发 Node SDK、`wx-server-sdk`

## Global Constraints

- 视频：H.264 Main/Baseline、yuv420p、宽度不超过 1280、帧率不超过 30、无 B 帧、最大关键帧间隔不超过 2 秒、moov 位于 mdat 前。
- 音频：无音轨，或 AAC；有音轨时转码为 AAC 128 kbps。
- 转码：`libx264`、Main、CRF 23、medium、`-bf 0`、`+faststart`，不放大，帧率只降不升。
- 本批替换只改播放文件、播放检查和 ingest 完成标记；保持上架状态、封面、简介、字幕和搜索字段。
- 云开发凭据只从 `TCB_ENV_ID`、`TCB_SECRET_ID`、`TCB_SECRET_KEY`、`ADMIN_PIN` 读取，不打印、不提交。
- worker 继续只允许运行一个实例；云函数内不运行 ffmpeg。
- 源码注释和 commit message 不写本地文档编号。

---

### Task 1: 统一播放规格、ffprobe 检查与 ffmpeg 参数

**Files:**
- Create: `scripts/video-ingest/lib/playbackProfile.js`
- Create: `scripts/video-ingest/lib/playbackProfile.test.js`

**Interfaces:**
- Produces: `probePlaybackMedia(filePath, runCommand, options?) -> PlaybackProbe`
- Produces: `assessPlaybackProfile(probe) -> { compliant: boolean, reasons: string[] }`
- Produces: `buildPlaybackFfmpegArgs(inputPath, outputPath, probe) -> string[]`
- Produces: `toPlaybackMetadata(probe) -> PlaybackMetadata`
- `PlaybackMetadata`: `{ videoCodec, profile, pixelFormat, width, height, frameRate, hasBFrames, maxKeyframeGapSec, fastStart, hasAudio, audioCodec, compliant }`

- [ ] **Step 1: 写播放规格的失败测试**

测试覆盖：

```js
const compliant = {
  durationSec: 60,
  videoCodec: 'h264',
  profile: 'Main',
  pixelFormat: 'yuv420p',
  width: 1280,
  height: 720,
  frameRate: 30,
  hasBFrames: false,
  maxKeyframeGapSec: 2,
  fastStart: true,
  hasAudio: true,
  audioCodec: 'aac',
};

assert.deepEqual(assessPlaybackProfile(compliant), {
  compliant: true,
  reasons: [],
});
for (const [field, value] of [
  ['videoCodec', 'hevc'],
  ['profile', 'High'],
  ['pixelFormat', 'yuv444p'],
  ['width', 1920],
  ['frameRate', 60],
  ['hasBFrames', true],
  ['maxKeyframeGapSec', 10],
  ['fastStart', false],
  ['audioCodec', 'opus'],
]) {
  const result = assessPlaybackProfile({ ...compliant, [field]: value });
  assert.equal(result.compliant, false, field);
  assert.equal(result.reasons.length > 0, true, field);
}
```

另测：

- `30000/1001` 解析为约 `29.97`
- ffprobe 的 packet 列表算出最大关键帧间隔
- MP4 顶层 box 中 `moov` 在 `mdat` 前才是 faststart
- 生成参数包含 `-profile:v main`、`-pix_fmt yuv420p`、`-bf 0`、`-fpsmax 30`、`-force_key_frames expr:gte(t,n_forced*2)`、`-sc_threshold 0`、`-movflags +faststart`
- 无音轨时参数含 `-an`；有音轨时含 `-c:a aac -b:a 128k`

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
node --test scripts/video-ingest/lib/playbackProfile.test.js
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现纯规格判断**

在 `playbackProfile.js` 定义稳定原因码：

```js
const LIMITS = Object.freeze({
  maxWidth: 1280,
  maxFrameRate: 30,
  maxKeyframeGapSec: 2,
});

function assessPlaybackProfile(probe) {
  const reasons = [];
  if (probe.videoCodec !== 'h264') reasons.push('VIDEO_CODEC');
  if (!['main', 'baseline', 'constrained baseline'].includes(String(probe.profile).toLowerCase())) {
    reasons.push('VIDEO_PROFILE');
  }
  if (probe.pixelFormat !== 'yuv420p') reasons.push('PIXEL_FORMAT');
  if (!Number.isInteger(probe.width) || probe.width > LIMITS.maxWidth) reasons.push('VIDEO_WIDTH');
  if (!Number.isInteger(probe.height) || probe.height % 2 !== 0) reasons.push('VIDEO_HEIGHT');
  if (!Number.isFinite(probe.frameRate) || probe.frameRate > LIMITS.maxFrameRate) reasons.push('FRAME_RATE');
  if (probe.hasBFrames) reasons.push('B_FRAMES');
  if (!Number.isFinite(probe.maxKeyframeGapSec) ||
      probe.maxKeyframeGapSec > LIMITS.maxKeyframeGapSec) {
    reasons.push('KEYFRAME_GAP');
  }
  if (probe.fastStart !== true) reasons.push('FASTSTART');
  if (probe.hasAudio && probe.audioCodec !== 'aac') reasons.push('AUDIO_CODEC');
  return { compliant: reasons.length === 0, reasons };
}
```

- [ ] **Step 4: 实现本地探测与转码参数**

`probePlaybackMedia` 用两次 ffprobe：

1. stream/format JSON：时长、codec、profile、pix_fmt、宽高、`avg_frame_rate`、`has_b_frames`
2. 视频 packet CSV：`pts_time,flags`，筛 `K` 并计算最大相邻间隔

用 `fs.openSync/readSync` 顺序解析 MP4 顶层 box 的 32 位或 64 位长度，记录第一个 `moov` 与 `mdat` 的偏移；不要用字节串全文搜索。单关键帧短片用 `durationSec - firstKeyframeTime` 补末段间隔。

`buildPlaybackFfmpegArgs` 生成：

```js
[
  '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
  '-i', inputPath,
  '-vf', "scale='min(1280,iw)':-2",
  '-c:v', 'libx264',
  '-profile:v', 'main',
  '-pix_fmt', 'yuv420p',
  '-preset', 'medium',
  '-crf', '23',
  '-bf', '0',
  '-fpsmax', '30',
  '-force_key_frames', 'expr:gte(t,n_forced*2)',
  '-sc_threshold', '0',
  ...(probe.hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
  '-movflags', '+faststart',
  outputPath,
]
```

- [ ] **Step 5: 运行播放规格测试**

Run:

```bash
node --test scripts/video-ingest/lib/playbackProfile.test.js
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add scripts/video-ingest/lib/playbackProfile.js scripts/video-ingest/lib/playbackProfile.test.js
git commit -m "feat(ingest): 统一小程序视频播放规格"
```

### Task 2: 批量预处理全部按统一规格归一化

**Files:**
- Modify: `scripts/video-ingest/preprocess.js`
- Modify: `scripts/video-ingest/preprocess.test.js`
- Modify: `scripts/video-ingest/lib/manifest.js`
- Modify: `scripts/video-ingest/lib/manifest.test.js`
- Modify: `scripts/video-ingest/lib/importPlan.js`
- Modify: `scripts/video-ingest/lib/importPlan.test.js`

**Interfaces:**
- Consumes: Task 1 的 `probePlaybackMedia`、`assessPlaybackProfile`、`buildPlaybackFfmpegArgs`、`toPlaybackMetadata`
- Produces: manifest 条目的 `media.playback` 与 `transcodeRequired`

- [ ] **Step 1: 修改测试，先证明 H.264 + AAC 但 10 秒关键帧也必须转码**

fake ffprobe 返回完整流信息和 packet 关键帧：

```js
streams: [
  {
    codec_type: 'video',
    codec_name: 'h264',
    profile: 'Main',
    pix_fmt: 'yuv420p',
    width: 1280,
    height: 720,
    avg_frame_rate: '30/1',
    has_b_frames: 0,
  },
  { codec_type: 'audio', codec_name: 'aac' },
]
```

packet 时间返回 `0,10,20`。断言：

```js
assert.equal(entry.transcodeRequired, true);
assert.equal(transcodeArgs.includes('-bf'), true);
assert.equal(transcodeArgs.includes('+faststart'), true);
```

再加一条完全合格的 2 秒关键帧 fixture，断言走 copy。

- [ ] **Step 2: 运行预处理和 manifest 测试确认失败**

Run:

```bash
node --test \
  scripts/video-ingest/preprocess.test.js \
  scripts/video-ingest/lib/manifest.test.js
```

Expected: 10 秒关键帧测试 FAIL。

- [ ] **Step 3: 让 manifest 接收完整 probe**

删除 `manifest.js` 中手写的 codec 判断。`buildManifestEntry` 接收 Task 1 的评估结果：

```js
const assessment = assessPlaybackProfile(probe);
return {
  // 原字段保持
  durationSec: probe.durationSec,
  media: {
    videoCodec: probe.videoCodec,
    audioCodec: probe.audioCodec,
    hasAudio: probe.hasAudio,
    playback: toPlaybackMetadata(probe),
  },
  transcodeRequired: !assessment.compliant,
};
```

预处理完成后必须再次 probe 输出文件，并把 `entry.media`、`entry.durationSec`、`entry.transcodeRequired` 更新为输出的真实值；二次检查不合格就抛出 `转码产物不符合播放规格：<原因码>`，不写 manifest。

`importPlan.js` 的 media 白名单增加 `playback` 并验证它来自合格的 prepared 文件；`buildDraftPayload` 把完整 `media` 交给 `upsertVideo`。这样以后批量导入的新草稿也带上可供上架门禁核对的检查结果。

- [ ] **Step 4: 替换 preprocess 的 probe 与 ffmpeg 参数**

- 删除本地 `probeMedia` 的简化逻辑，改用 Task 1。
- `prepareMedia` 接收 probe，转码时调用 `buildPlaybackFfmpegArgs`。
- 不合格文件转码，合格文件复制。
- 封面与关键帧从最终 prepared media 抽取。

- [ ] **Step 5: 运行相关测试**

Run:

```bash
npm test --prefix scripts/video-ingest
```

Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add scripts/video-ingest/preprocess.js scripts/video-ingest/preprocess.test.js \
  scripts/video-ingest/lib/manifest.js scripts/video-ingest/lib/manifest.test.js \
  scripts/video-ingest/lib/importPlan.js scripts/video-ingest/lib/importPlan.test.js
git commit -m "fix(ingest): 批量入库按播放规格重编码"
```

### Task 3: 运营上传 worker 使用相同规格并回写检查结果

**Files:**
- Modify: `scripts/video-ingest/worker.js`
- Modify: `scripts/video-ingest/worker.test.js`
- Modify: `scripts/video-ingest/lib/workerLoop.js`
- Modify: `scripts/video-ingest/lib/workerLoop.test.js`
- Modify: `cloudfunctions/catalog/lib/videoMediaMetadata.js`
- Modify: `cloudfunctions/catalog/lib/videoMediaMetadata.test.js`
- Modify: `cloudfunctions/catalog/lib/videoIngestActions.js`
- Modify: `cloudfunctions/catalog/lib/videoIngestActions.test.js`

**Interfaces:**
- Consumes: Task 1 的播放探测、判断、转码参数和 metadata
- Produces: `completeVideoIngest` 的 `media.playback`，且 `ingest.videoFileId` 与最终文件一致

- [ ] **Step 1: 为 worker 写失败测试**

新增断言：

- H.264 + AAC、10 秒关键帧时 `needsTranscode === true`
- 转码后第二次 probe 仍不合格时回写 `TRANSCODE_FAILED`
- 合格时 complete payload 含 `media.playback`
- 转码参数来自 Task 1，并包含 Main、无 B 帧、2 秒关键帧和 faststart
- 原片已合格时不上传新文件，complete 使用原 `videoFileId`
- 转码并成功回写后删除原始云文件
- 转码后 ASR 或回写失败时删除新产物，保留原始云文件

- [ ] **Step 2: 为云端媒体归一化写失败测试**

允许 `media.playback` 的精确字段集合，拒绝额外字段、NaN、错误类型和 `compliant !== true`。断言不带新 `media` 的普通运营保存会保留已有 `media.playback`，而不是清掉。

- [ ] **Step 3: 运行 worker 与云端单测确认失败**

Run:

```bash
node --test \
  scripts/video-ingest/worker.test.js \
  scripts/video-ingest/lib/workerLoop.test.js \
  cloudfunctions/catalog/lib/videoMediaMetadata.test.js \
  cloudfunctions/catalog/lib/videoIngestActions.test.js
```

Expected: 新断言 FAIL。

- [ ] **Step 4: 替换 worker 的简化探测与转码**

`probeLocalMedia` 委托给 `probePlaybackMedia`，添加：

```js
const assessment = assessPlaybackProfile(probe);
return {
  ...probe,
  needsTranscode: !assessment.compliant,
  playback: toPlaybackMetadata(probe),
};
```

`transcodeLocalMedia` 用 `buildPlaybackFfmpegArgs`。`workerLoop` 在转码后的第二次 probe 后显式检查：

```js
if (!probe.playback || probe.playback.compliant !== true) {
  return completeFailure(catalog, claimed, 'TRANSCODE_FAILED');
}
```

`mediaPayload` 写：

```js
media: {
  hasAudio: probe.hasAudio,
  videoCodec: probe.videoCodec,
  audioCodec: probe.audioCodec,
  playback: probe.playback,
}
```

给 `workerLoop` 增加 `deleteCloudFiles(fileIds)` 依赖。只有 `catalog.complete` 成功后才删除原始 `claimed.videoFileId`；若转码后任一后续步骤失败，则删除 `prepared.uploadedFileId`。删除失败记录受控警告但不反转已成功的数据库回写，不把 fileID 或临时 URL 打进日志。

- [ ] **Step 5: 扩展云端 metadata 并保持旧值**

`videoMediaMetadata.js`：

- `ALLOWED_MEDIA_KEYS` 增加 `playback`
- 定义 playback 的精确键和数值/布尔类型检查
- `defaultMedia` 深复制以前的 playback
- 只有 complete payload 明确提供 playback 时更新

`applyCompleteToVideo` 继续把归一化后的 `media` 写进记录。不要让 `upsertVideo` 从管理页自由覆盖已经生成的 playback；保存表单没有 `media` 时保留旧值。

- [ ] **Step 6: 运行相关测试**

Run:

```bash
node --test \
  scripts/video-ingest/worker.test.js \
  scripts/video-ingest/lib/workerLoop.test.js \
  cloudfunctions/catalog/lib/videoMediaMetadata.test.js \
  cloudfunctions/catalog/lib/videoIngestActions.test.js
```

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add scripts/video-ingest/worker.js scripts/video-ingest/worker.test.js \
  scripts/video-ingest/lib/workerLoop.js scripts/video-ingest/lib/workerLoop.test.js \
  cloudfunctions/catalog/lib/videoMediaMetadata.js \
  cloudfunctions/catalog/lib/videoMediaMetadata.test.js \
  cloudfunctions/catalog/lib/videoIngestActions.js \
  cloudfunctions/catalog/lib/videoIngestActions.test.js
git commit -m "fix(ingest): 运营上传完成前强制校验播放规格"
```

### Task 4: 收紧上架门禁并防止换片沿用旧检查

**Files:**
- Modify: `cloudfunctions/catalog/lib/videoPublishGate.js`
- Modify: `cloudfunctions/catalog/lib/videoPublishGate.test.js`
- Modify: `cloudfunctions/catalog/lib/videoIngest.js`
- Modify: `cloudfunctions/catalog/lib/videoIngest.test.js`
- Modify: `miniprogram/pages/admin/edit/edit.js`
- Create: `miniprogram/pages/admin/edit/edit.test.js`

**Interfaces:**
- Consumes: `doc.ingest.phase`、`doc.ingest.videoFileId`、`doc.videoFileId`、`doc.media.playback.compliant`
- Produces: 只有最终处理文件才能发布的门禁

- [ ] **Step 1: 写上架失败测试**

把旧的“failed/无 ingest 也允许发布”期望改为拒绝，并覆盖：

```js
const ready = {
  ...base,
  ingest: { phase: 'ready', videoFileId: 'cloud://processed' },
  videoFileId: 'cloud://processed',
  media: { playback: { compliant: true } },
};
assert.equal(isReadyToPublish(ready), true);
assert.equal(isReadyToPublish({ ...ready, ingest: { ...ready.ingest, phase: 'failed' } }), false);
assert.equal(isReadyToPublish({ ...ready, ingest: { ...ready.ingest, videoFileId: 'cloud://old' } }), false);
assert.equal(isReadyToPublish({ ...ready, media: {} }), false);
```

另测换新原片后旧 `media.playback` 被清掉，phase 回到 queued。

- [ ] **Step 2: 运行门禁测试确认失败**

Run:

```bash
node --test \
  cloudfunctions/catalog/lib/videoPublishGate.test.js \
  cloudfunctions/catalog/lib/videoIngest.test.js \
  miniprogram/pages/admin/edit/edit.test.js
```

Expected: failed/缺检查仍被允许的断言 FAIL。

- [ ] **Step 3: 实现严格门禁**

`assertReadyToPublish` 增加：

```js
if (doc?.ingest?.phase !== 'ready') fail('视频处理完成前不能上架');
if (doc.ingest.videoFileId !== doc.videoFileId) fail('视频文件尚未完成处理');
if (doc?.media?.playback?.compliant !== true) fail('视频未通过播放规格检查');
```

`planAdminSave` 在 `nextVideoFileId !== prevVideoFileId` 时清除 `media.playback`。为避免媒体归一化随后又从 `previous` 恢复旧值，让计划结果增加 `clearPlayback: true`，`saveVideo` 在构造 `mediaInput` 时显式传入无 playback 的基础 media。

- [ ] **Step 4: 管理页保持发布按钮与云端门禁一致**

编辑页 view model 的 `canPublish` 必须要求：

```js
ingest.phase === 'ready' &&
ingest.videoFileId === video.videoFileId &&
video.media?.playback?.compliant === true
```

提示分别使用“等待视频处理”“视频处理失败，请重试”“视频未通过播放检查”。

- [ ] **Step 5: 运行测试**

Run:

```bash
node --test \
  cloudfunctions/catalog/lib/videoPublishGate.test.js \
  cloudfunctions/catalog/lib/videoIngest.test.js \
  cloudfunctions/catalog/lib/videoIngestActions.test.js \
  miniprogram/pages/admin/edit/edit.test.js
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add cloudfunctions/catalog/lib/videoPublishGate.js \
  cloudfunctions/catalog/lib/videoPublishGate.test.js \
  cloudfunctions/catalog/lib/videoIngest.js \
  cloudfunctions/catalog/lib/videoIngest.test.js \
  cloudfunctions/catalog/lib/videoIngestActions.js \
  cloudfunctions/catalog/lib/videoIngestActions.test.js \
  miniprogram/pages/admin/edit/edit.js \
  miniprogram/pages/admin/edit/edit.test.js
git commit -m "fix(catalog): 仅允许处理合格的视频上架"
```

### Task 5: 为存量文件提供原子替换 action

**Files:**
- Modify: `cloudfunctions/catalog/index.js`
- Modify: `cloudfunctions/catalog/lib/videoIngestActions.js`
- Modify: `cloudfunctions/catalog/lib/videoIngestActions.test.js`

**Interfaces:**
- Produces: 管理 action `replacePlaybackMedia`
- Input: `{ id, expectedVideoFileId, videoFileId, durationSec, media, ticket }`
- Output: `{ ok: true, id, oldVideoFileId }`

- [ ] **Step 1: 写 action 失败测试**

覆盖：

- 记录不存在 → `NOT_FOUND`
- `expectedVideoFileId` 与当前值不同 → `BAD_INPUT`
- playback 不合格 → `BAD_INPUT`
- 成功时只更新 `videoFileId`、`durationSec`、`media`、`ingest`、`updatedAt`
- 成功时保留 `status`、`publishedAt`、cover、intro、transcript、searchBlob
- 成功时 `mediaRevision + 1`、`phase: ready`、`ingest.videoFileId` 等于新文件

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
node --test cloudfunctions/catalog/lib/videoIngestActions.test.js
```

Expected: `replacePlaybackMedia` 不存在。

- [ ] **Step 3: 实现事务方法**

在 `createVideoIngestActions` 返回：

```js
async function replacePlaybackMedia({
  id,
  expectedVideoFileId,
  videoFileId,
  durationSec,
  media,
}) {
  // require fields, normalizeVideoMedia, require playback.compliant
  // transaction get current; compare expected; increment mediaRevision
  // update only media identity/metadata/ingest timestamps
  return { ok: true, id, oldVideoFileId: expectedVideoFileId };
}
```

ingest patch：

```js
{
  ...normalizeIngest(current.ingest),
  phase: 'ready',
  mediaRevision: normalizeIngest(current.ingest).mediaRevision + 1,
  videoFileId,
  errorCode: '',
  errorMessage: '',
  queuedAt: 0,
  startedAt: 0,
  finishedAt: now(),
}
```

- [ ] **Step 4: 接入 catalog dispatch**

`index.js` 增加 `replacePlaybackMedia` case 和 handler。handler 先 `requireAdmin(event.ticket)`，再只把精确字段交给 action；不要复用 `upsertVideo`。

- [ ] **Step 5: 运行 catalog 单测**

Run:

```bash
node --test cloudfunctions/catalog/lib/*.test.js
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add cloudfunctions/catalog/index.js \
  cloudfunctions/catalog/lib/videoIngestActions.js \
  cloudfunctions/catalog/lib/videoIngestActions.test.js
git commit -m "feat(catalog): 增加存量播放文件原子替换接口"
```

### Task 6: 存量 23 条归一化与替换脚本

**Files:**
- Create: `scripts/video-ingest/normalize-prepared.js`
- Create: `scripts/video-ingest/normalize-prepared.test.js`
- Create: `scripts/video-ingest/replace-playback.js`
- Create: `scripts/video-ingest/replace-playback.test.js`
- Modify: `scripts/video-ingest/README.md`

**Interfaces:**
- Consumes: Task 1 的探测、判断、ffmpeg 参数；Task 5 的 `replacePlaybackMedia`
- Produces: `normalize-prepared.js --manifest <path>` 原子重写 prepared media 和 manifest
- Produces: `replace-playback.js --manifest <path> [--dry-run|--execute]`

- [ ] **Step 1: 写 prepared 归一化失败测试**

覆盖：

- 不合格文件转码到同目录临时文件
- 临时文件检查合格后才 rename 覆盖原 prepared media
- 检查失败时删除临时文件、保留原文件
- manifest 原子写入真实 `durationSec`、`media.playback`、`transcodeRequired: true`
- 不读取 manifest 目录外文件，不跟随逃逸软链

- [ ] **Step 2: 实现 normalize-prepared**

对每个 entry：

1. `resolvePreparedFile` 校验路径。
2. probe 原文件。
3. 若不合格，写 `<slug>.normalizing.mp4`。
4. probe 临时文件并要求合格。
5. `renameSync` 原子替换；更新 manifest。
6. 若原文件已合格，只更新 playback metadata。

CLI 成功输出“合格、重编码、失败”数量；任一失败退出码为 1。

- [ ] **Step 3: 写替换脚本失败测试**

覆盖：

- 默认 dry-run，且 dry-run 不创建 SDK app、不上传
- 标题唯一匹配才列为 ready
- 零条、多条、prepared 不合格列为 rejected
- execute 先上传，再调用 `replacePlaybackMedia`
- action 失败时删除新文件，不删除旧文件
- action 成功后删除旧文件；旧文件删除失败只列 warning
- 输出和错误不包含凭据、ticket、本地绝对路径

- [ ] **Step 4: 实现 dry-run 计划**

登录后先调用 `adminListBrands`，再按每个 `brandId` 调用现有 `adminListVideos` 取得完整记录，按 trim 后标题精确匹配。计划项：

```js
{
  title,
  videoId,
  oldVideoFileId,
  localPath,
  durationSec,
  media,
}
```

dry-run 可读取远端清单，但不得上传、写库或删文件。没有凭据时明确停止，因为无法确认线上匹配。

- [ ] **Step 5: 实现 execute 补偿顺序**

每条：

```js
const uploaded = await app.uploadFile({
  cloudPath: `video/processed/${crypto.randomUUID()}.mp4`,
  fileContent: fs.createReadStream(localPath),
});
try {
  await callCatalog(app, {
    action: 'replacePlaybackMedia',
    ticket,
    id: videoId,
    expectedVideoFileId: oldVideoFileId,
    videoFileId: uploaded.fileID,
    durationSec,
    media,
  });
} catch (error) {
  await app.deleteFile({ fileList: [uploaded.fileID] }).catch(() => {});
  throw error;
}
await app.deleteFile({ fileList: [oldVideoFileId] }).catch(recordWarning);
```

各条独立执行；一条失败不撤销已成功条目。最后打印成功、失败、拒绝、warning 的标题列表。

- [ ] **Step 6: 更新 README**

增加三段准确命令：

```bash
node scripts/video-ingest/normalize-prepared.js \
  --manifest .video-ingest/prepared/manifest.json

node scripts/video-ingest/replace-playback.js \
  --manifest .video-ingest/prepared/manifest.json \
  --dry-run

node scripts/video-ingest/replace-playback.js \
  --manifest .video-ingest/prepared/manifest.json \
  --execute
```

说明 execute 前必须备份 manifest、确认只有一个 worker、先部署新版 `catalog`、凭据来自环境变量。

- [ ] **Step 7: 运行脚本测试**

Run:

```bash
node --test \
  scripts/video-ingest/normalize-prepared.test.js \
  scripts/video-ingest/replace-playback.test.js
```

Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add scripts/video-ingest/normalize-prepared.js \
  scripts/video-ingest/normalize-prepared.test.js \
  scripts/video-ingest/replace-playback.js \
  scripts/video-ingest/replace-playback.test.js \
  scripts/video-ingest/README.md
git commit -m "feat(ingest): 增加存量视频归一化与安全替换"
```

### Task 7: 全量验证、部署云函数并替换体验版片源

**Files:**
- Modify generated local-only files: `.video-ingest/prepared/media/*.mp4`
- Modify generated local-only file: `.video-ingest/prepared/manifest.json`

**Interfaces:**
- Consumes: 前六个任务的代码与本机云开发凭据
- Produces: 云端 23 条记录指向合格的新文件

- [ ] **Step 1: 跑完整自动化测试**

Run:

```bash
npm test --prefix scripts/video-ingest
node --test cloudfunctions/catalog/lib/*.test.js
node --test miniprogram/pages/admin/edit/edit.test.js
```

Expected: 全部 PASS。

- [ ] **Step 2: 对本地 prepared 目录执行归一化**

先备份 manifest：

```bash
cp .video-ingest/prepared/manifest.json \
  .video-ingest/prepared/manifest.before-playback-normalize.json
node scripts/video-ingest/normalize-prepared.js \
  --manifest .video-ingest/prepared/manifest.json
```

Expected: 23 条检查合格；首次运行 23 条均重编码。

- [ ] **Step 3: 独立复核所有本地成品**

Run:

```bash
node scripts/video-ingest/normalize-prepared.js \
  --manifest .video-ingest/prepared/manifest.json
```

Expected: 23 条合格、0 条重编码、0 条失败，证明第二次运行幂等。

- [ ] **Step 4: 部署更新后的 catalog 云函数**

在微信开发者工具中对 `cloudfunctions/catalog` 执行“上传并部署：云端安装依赖”。部署后先调用 `ping`，再用管理端现有视频做只读列表确认。不要在旧云函数上运行替换脚本，因为它没有 `replacePlaybackMedia`。

- [ ] **Step 5: 干跑线上替换**

确保环境中已有四项凭据，然后：

```bash
node scripts/video-ingest/replace-playback.js \
  --manifest .video-ingest/prepared/manifest.json \
  --dry-run
```

Expected: ready 23、rejected 0；每个标题唯一匹配，且只列这 23 条。

- [ ] **Step 6: 执行线上替换**

```bash
node scripts/video-ingest/replace-playback.js \
  --manifest .video-ingest/prepared/manifest.json \
  --execute
```

Expected: succeeded 23、failed 0、rejected 0。若凭据、权限或配额明确拒绝，停止，不反复重试。

- [ ] **Step 7: 回读云端并验证真机**

再次 dry-run 应显示记录已指向 manifest 对应的新文件，且无需再替换。真机体验版抽测：

- 原 60 帧片：「南方面测量」「南方数据导出」
- 原约 1.6 Mbps 片一条
- 当前打开封面对应的 `8d28a4ca842777a4`
- 拖动进度条后继续播放
- Wi-Fi 与移动网络各看一轮

记录首播时间、是否缓冲、拖动后恢复时间；不以开发者工具播放代替真机验证。

- [ ] **Step 8: 最终工作区与提交检查**

Run:

```bash
git status --short
git log --oneline -8
```

Expected: 只有 `.video-ingest/` 本地生成物保持未跟踪/忽略；源码和文档均已提交，不提交 mp4、凭据或备份 manifest。

