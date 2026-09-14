# 讲解入库与口播转写 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把本地讲解视频稳定转换为可审查、可重复导入的草稿数据包，并让 `videos` 以分段字幕为唯一口播事实源，支撑后续 `video_doc` 多轮问答。

**Architecture:** 本地 Node CLI 负责扫描、去重、ffprobe、必要转码、封面和关键帧抽取，产出不进 git 的 prepared 目录与 manifest；Python CLI 用 faster-whisper 生成带时间轴字幕。云函数保存时从字幕段派生全文和搜索缓存，远程导入器仅在具备云开发凭据时上传资产并写草稿。关键帧只用于本地撰写按步骤伸缩的 `intro`。

**Tech Stack:** Node.js CommonJS、`node:test`、Python 3 `unittest`、FFmpeg/ffprobe、faster-whisper、微信云开发 `catalog`。

## Global Constraints

- 分支固定为 `dev-video-kb-ingest`，不得在 `dev` / `main` 直接开发。
- 本批默认写 `draft`，脚本不得调用 `publishVideo`。
- 视频、音频、关键帧、ASR 模型与 prepared 目录不得提交 git。
- 小程序播放资产必须是 H.264 + AAC；HEVC 先转码，源文件不覆盖。
- `transcriptSegments` 是唯一口播事实源；`transcript` 与 `searchBlob` 保存时派生。
- 本批 `searchAbstract` 为空，`entities` 四桶为空，动作关键词只写 `tags`。
- A2 `intro` 每步一句，字数随真实步骤变化且不超过 400 字；没有证据的按钮名或步骤不得编写。
- 关键帧除封面外不得上传、不得注入运行时 agent、不得发送给云端多模态 API。
- 密钥、`ADMIN_PIN`、环境 ID 与本地绝对路径不得写入仓库或数据库。

---

### Task 1: 字幕事实源与派生规则

**Files:**
- Create: `cloudfunctions/catalog/lib/videoKnowledge.js`
- Create: `cloudfunctions/catalog/lib/videoKnowledge.test.js`
- Modify: `cloudfunctions/catalog/index.js`

**Interfaces:**
- Consumes: `normalizeVideoKnowledge({ transcriptSegments, transcript })`
- Produces: `{ transcriptSegments, transcript }`；校验失败抛出 `error.code = 'BAD_INPUT'`

- [ ] **Step 1: Write failing tests**

测试覆盖：

```js
it('normalizes ordered segments and derives transcript', () => {
  const out = normalizeVideoKnowledge({
    transcriptSegments: [
      { startSec: 1.2, endSec: 2.8, text: ' 打开项目 ' },
      { startSec: 3, endSec: 4, text: '点击测量' },
    ],
  });
  assert.deepEqual(out.transcriptSegments, [
    { startSec: 1.2, endSec: 2.8, text: '打开项目' },
    { startSec: 3, endSec: 4, text: '点击测量' },
  ]);
  assert.equal(out.transcript, '打开项目\n点击测量');
});

it('rejects a conflicting handwritten transcript', () => {
  assert.throws(
    () => normalizeVideoKnowledge({
      transcriptSegments: [{ startSec: 0, endSec: 1, text: '打开项目' }],
      transcript: '另一份全文',
    }),
    (error) => error.code === 'BAD_INPUT',
  );
});
```

另测负时间、`endSec <= startSec`、倒序、空文本均拒绝；空分段派生空全文。

- [ ] **Step 2: Run and verify RED**

Run:

```bash
node --test cloudfunctions/catalog/lib/videoKnowledge.test.js
```

Expected: FAIL because `./videoKnowledge` does not exist.

- [ ] **Step 3: Implement the pure normalizer**

实现 `badInput(message)`、`normalizeVideoKnowledge(input)`；只接受有限数值，保持调用方顺序并校验单调递增，不偷偷排序。若请求同时传入 `transcript`，仅允许它等于派生全文。

- [ ] **Step 4: Integrate into `upsertVideo`**

在读取 `prevData` 后决定分段来源：

```js
const hasSegments = Object.prototype.hasOwnProperty.call(event, 'transcriptSegments');
const knowledge = normalizeVideoKnowledge({
  transcriptSegments: hasSegments
    ? event.transcriptSegments
    : (prevData && prevData.transcriptSegments) || [],
  transcript: hasSegments ? event.transcript : undefined,
});
```

payload 的 `transcriptSegments` / `transcript` 只用 `knowledge`，然后再调用 `buildSearchBlob(payload)`。管理端未提交字幕时保留旧分段并重新派生全文。

- [ ] **Step 5: Run focused and catalog tests**

```bash
node --test cloudfunctions/catalog/lib/videoKnowledge.test.js cloudfunctions/catalog/lib/catalogSearch.test.js cloudfunctions/catalog/lib/videoPublishGate.test.js
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add cloudfunctions/catalog/index.js cloudfunctions/catalog/lib/videoKnowledge.js cloudfunctions/catalog/lib/videoKnowledge.test.js
git commit -m "feat(catalog): 以分段字幕派生视频口播全文"
```

---

### Task 2: 最小媒体元数据保存

**Files:**
- Create: `cloudfunctions/catalog/lib/videoMediaMetadata.js`
- Create: `cloudfunctions/catalog/lib/videoMediaMetadata.test.js`
- Modify: `cloudfunctions/catalog/index.js`

**Interfaces:**
- Consumes: `normalizeVideoMedia({ durationSec, media }, previous)`
- Produces: `{ durationSec, media: { videoCodec, audioCodec, hasAudio } }`

- [ ] **Step 1: Write failing tests**

覆盖：有效 `durationSec` 四舍五入到一位小数；codec 转小写；`hasAudio` 必须布尔；拒绝负时长；拒绝 `width`、`fps`、`sourceBytes` 等超出契约字段；管理端未传媒体信息时完整保留 previous。

- [ ] **Step 2: Run and verify RED**

```bash
node --test cloudfunctions/catalog/lib/videoMediaMetadata.test.js
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement normalizer and integrate**

新草稿要求入库脚本传入完整最小媒体元数据；兼容历史管理端表单：若 event 没有 `durationSec` / `media`，保留旧值或默认 `0` / 空 codec / `false`。不得把媒体字段拼进 `searchBlob`，不得下发首页列表。

- [ ] **Step 4: Run tests**

```bash
node --test cloudfunctions/catalog/lib/videoMediaMetadata.test.js cloudfunctions/catalog/lib/*.test.js
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/catalog/index.js cloudfunctions/catalog/lib/videoMediaMetadata.js cloudfunctions/catalog/lib/videoMediaMetadata.test.js
git commit -m "feat(catalog): 保存视频时长与最小编码元数据"
```

---

### Task 3: 本地媒体预处理器

**Files:**
- Create: `scripts/video-ingest/lib/manifest.js`
- Create: `scripts/video-ingest/lib/manifest.test.js`
- Create: `scripts/video-ingest/preprocess.js`
- Create: `scripts/video-ingest/content.zh-CN.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `node scripts/video-ingest/preprocess.js --input <目录> --output <目录>`
- Produces: `<output>/manifest.json`、`media/*.mp4`、`covers/*.jpg`、`keyframes/<slug>/*.jpg`

- [ ] **Step 1: Write failing manifest tests**

用虚拟扫描记录测试：

- 字节哈希相同的 `_副本` 只保留正片；
- `中海达主机固件升级_副本` 被规则排除；
- `司南/南方参数计算.mp4` 归属南方；
- 文件名末尾空格被清理；
- HEVC 条目标记 `transcodeRequired=true`；
- `content.zh-CN.json` 能按规范化标题补齐 `intro` / `tags` / `modelName`。

- [ ] **Step 2: Run and verify RED**

```bash
node --test scripts/video-ingest/lib/manifest.test.js
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement manifest library**

导出：

```js
normalizeTitle(fileName)
assignBrand(relativePath, title)
selectCandidates(files)
buildManifestEntry(file, probe, content)
```

manifest 条目不得包含源文件绝对路径；用 `sourceRelativePath`。每条包含稳定 `sourceKey`（相对路径内容哈希）、标题、品牌、tags、A1 intro、型号、duration/media、prepared 相对路径、状态 `prepared`。

- [ ] **Step 4: Implement CLI with injectable command runner**

CLI 启动时检查 `ffprobe` / `ffmpeg`；扫描 `.mp4`，SHA-256 去重，ffprobe 读信息；HEVC 用：

```bash
ffmpeg -i INPUT -vf "scale='min(1280,iw)':-2" -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 128k -movflags +faststart OUTPUT
```

H.264 + AAC 原片复制到 output，不覆盖 Downloads。封面抽第 1 秒；关键帧每 8 秒抽一张到本地 output。所有命令参数使用数组形式调用 `spawnSync`，不拼 shell 字符串。

- [ ] **Step 5: Ignore generated assets**

`.gitignore` 追加：

```gitignore
.video-ingest/
```

- [ ] **Step 6: Run tests and dry run**

```bash
node --test scripts/video-ingest/lib/manifest.test.js
node scripts/video-ingest/preprocess.js \
  --input "/Users/forsertree/Downloads/视频合集" \
  --output "/Users/forsertree/code/HQH/.video-ingest/prepared"
```

Expected: manifest 有 23 条；所有 prepared 视频为 H.264 + AAC；点测量重复与主机升级副本各排除一条。

- [ ] **Step 7: Commit code only**

```bash
git add .gitignore scripts/video-ingest
git commit -m "feat(ingest): 批量质检转码并生成视频草稿清单"
```

---

### Task 4: 本地 ASR 与字幕标准化

**Files:**
- Create: `scripts/video-ingest/transcribe.py`
- Create: `scripts/video-ingest/test_transcribe.py`
- Create: `scripts/video-ingest/requirements-asr.txt`

**Interfaces:**
- Consumes: prepared `manifest.json` 与 `media/*.mp4`
- Produces: 回写每条 manifest 的 `transcriptSegments`、`transcription.status`；不手写 `transcript`

- [ ] **Step 1: Write failing Python unit tests**

测试纯函数 `normalize_segments(raw, duration_sec)`：

- trim 空白并丢弃空段；
- 校验并裁剪到 `[0, durationSec]`；
- 超过 80 字按 `。！？；` 切分并按字符比例分配时间；
- 输出保持升序，不产生零长度段。

- [ ] **Step 2: Run and verify RED**

```bash
python3 -m unittest scripts/video-ingest/test_transcribe.py
```

Expected: FAIL because `transcribe` cannot be imported.

- [ ] **Step 3: Implement ASR CLI**

依赖固定：

```text
faster-whisper>=1.1,<2
```

CLI 参数：

```bash
python3 scripts/video-ingest/transcribe.py \
  --manifest .video-ingest/prepared/manifest.json \
  --model medium \
  --language zh
```

逐片保存 checkpoint，单片失败写 `transcription.status=failed` 与不含路径/密钥的短错误；成功写 `ready` 和 segments。重复执行跳过 ready，`--force` 才重跑。

- [ ] **Step 4: Run unit tests**

```bash
python3 -m unittest scripts/video-ingest/test_transcribe.py
```

Expected: PASS.

- [ ] **Step 5: Install isolated dependency and transcribe**

```bash
python3 -m venv .video-ingest/venv
.video-ingest/venv/bin/pip install -r scripts/video-ingest/requirements-asr.txt
.video-ingest/venv/bin/python scripts/video-ingest/transcribe.py \
  --manifest .video-ingest/prepared/manifest.json \
  --model medium \
  --language zh
```

Expected: 有音轨条目为 ready；失败条目明确标记且不伪造字幕。

- [ ] **Step 6: Commit**

```bash
git add scripts/video-ingest/transcribe.py scripts/video-ingest/test_transcribe.py scripts/video-ingest/requirements-asr.txt
git commit -m "feat(ingest): 本地转写并生成带时间轴字幕"
```

---

### Task 5: 口播与关键帧生成动态步骤介绍

**Files:**
- Create: `scripts/video-ingest/lib/intro.js`
- Create: `scripts/video-ingest/lib/intro.test.js`
- Create: `scripts/video-ingest/apply-intros.js`
- Runtime-only: `.video-ingest/prepared/intros.review.json`

**Interfaces:**
- Consumes: manifest 字幕、关键帧目录和人工/agent 审核后的 `intros.review.json`
- Produces: manifest 每条 `intro` 与 `introStatus='reviewed'`

- [ ] **Step 1: Write failing validation tests**

`validateReviewedIntro({ intro, transcriptSegments })` 测试：

- 非空且不超过 400 字；
- 拒绝仍等于 A1 占位句；
- 至少一个实词片段能在字幕中找到（防止完全脱离视频）；
- 不按固定最小字数拒绝，50 字的真实两步说明可通过。

- [ ] **Step 2: Run and verify RED**

```bash
node --test scripts/video-ingest/lib/intro.test.js
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement validator and apply CLI**

`apply-intros.js` 只接受按 `sourceKey` 对应的 review 文件；失败条目不覆盖 A1 intro。review 文件留在 ignored prepared 目录，不进仓库。

- [ ] **Step 4: Produce and review real intros**

逐条读取字幕与关键帧，按「每步一句，动作 + 屏幕可见按钮名，可选约第 N 秒」写 `intros.review.json`。短片允许几十字；没有字幕证据或帧看不清时删掉该细节，不猜。

- [ ] **Step 5: Apply and verify**

```bash
node scripts/video-ingest/apply-intros.js \
  --manifest .video-ingest/prepared/manifest.json \
  --reviews .video-ingest/prepared/intros.review.json
node --test scripts/video-ingest/lib/intro.test.js
```

Expected: ASR ready 的条目 introStatus 均为 reviewed 且 intro 不超过 400 字。

- [ ] **Step 6: Commit code only**

```bash
git add scripts/video-ingest/lib/intro.js scripts/video-ingest/lib/intro.test.js scripts/video-ingest/apply-intros.js
git commit -m "feat(ingest): 校验并应用按步骤生成的视频介绍"
```

---

### Task 6: 云端草稿导入适配器

**Files:**
- Create: `scripts/video-ingest/lib/importPlan.js`
- Create: `scripts/video-ingest/lib/importPlan.test.js`
- Create: `scripts/video-ingest/import.js`
- Create: `scripts/video-ingest/README.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: reviewed manifest、云开发上传/调用适配器、运行时凭据
- Produces: 云存储 `video/*` / `cover/*` 与 `videos` draft；manifest 回写 fileId / video id / import status

- [ ] **Step 1: Write failing import-plan tests**

覆盖：

- 字幕 ready 但 intro 未 reviewed → 拒绝导入；
- 缺少封面/媒体文件 → 拒绝；
- payload 仅含 spec 允许字段，`searchAbstract=''`、entities 四桶空；
- 不产生 `publishVideo` action；
- 已成功条目幂等跳过。

- [ ] **Step 2: Run and verify RED**

```bash
node --test scripts/video-ingest/lib/importPlan.test.js
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement dry-run first**

默认只输出脱敏导入计划；只有显式 `--execute` 才上传。远程适配器从进程环境/已登录 CLI 读取凭据，不读取仓库文件。缺权限直接停止，不重复上传。

- [ ] **Step 4: Document credential boundary**

文档写清：

- 无凭据：只运行 preprocess / transcribe / apply-intros / `import --dry-run`；
- 有凭据：先在当前云开发环境验证品牌与 `catalog` 已部署，再 `--execute`；
- 禁止把 `ADMIN_PIN`、SecretId、SecretKey 写进命令历史或 manifest；
- 导入后仍是 draft，去管理端抽检并手工上架。

- [ ] **Step 5: Test and dry-run**

```bash
node --test scripts/video-ingest/lib/importPlan.test.js
node scripts/video-ingest/import.js \
  --manifest .video-ingest/prepared/manifest.json \
  --dry-run
```

Expected: 23 条 draft payload，无密钥、绝对路径或 publish action。

- [ ] **Step 6: Execute only when authenticated**

凭据或已登录环境可用时：

```bash
node scripts/video-ingest/import.js \
  --manifest .video-ingest/prepared/manifest.json \
  --execute
```

若认证未就绪，记录为外部阻塞；不削弱鉴权、不把凭据写进仓库。

- [ ] **Step 7: Commit**

```bash
git add scripts/video-ingest README.md
git commit -m "feat(ingest): 以草稿模式幂等导入讲解视频"
```

---

### Task 7: 仓库级入库 skill（流程稳定后）

**Files:**
- Create: `.cursor/skills/hqh-video-ingest/SKILL.md`

**Interfaces:**
- Consumes: 用户提供本地视频目录
- Produces: 强制按本计划脚本执行的可审查 prepared 数据包；不会绕过草稿、鉴权和隐私闸门

- [ ] **Step 1: Run baseline pressure scenario**

在没有 skill 的情况下让子代理处理「把某目录视频批量入库并做问答资料」，记录它是否跳过：去重、HEVC 转码、字幕事实源、关键帧不外发、dry-run、草稿状态、凭据边界。

- [ ] **Step 2: Write the minimal skill**

YAML frontmatter 必须含：

```yaml
---
name: hqh-video-ingest
description: Use when preprocessing and importing local survey-instrument videos into the HQH videos collection for search and video_doc Q&A
---
```

正文只描述判断顺序与硬闸门，命令引用 `scripts/video-ingest/README.md`，数据契约引用本 spec；不复制完整实现。

- [ ] **Step 3: Re-run pressure scenario with skill**

要求代理先 dry-run、拒绝泄密/自动上架/外发关键帧，并能在缺云凭据时停在 prepared 数据包而不是声称已上传。

- [ ] **Step 4: Verify metadata and paths**

确认 skill 名称与目录一致，所有相对路径存在，无 `..` / 绝对路径，无未解释占位。

- [ ] **Step 5: Commit**

```bash
git add .cursor/skills/hqh-video-ingest/SKILL.md
git commit -m "docs(skill): 固化讲解视频预处理与草稿入库流程"
```

---

### Task 8: 全量验证

**Files:**
- Verify only

- [ ] **Step 1: Run all automated tests**

```bash
node --test \
  cloudfunctions/catalog/lib/*.test.js \
  cloudfunctions/shop/lib/*.test.js \
  miniprogram/utils/*.test.js \
  miniprogram/constants/*.test.js \
  scripts/video-ingest/lib/*.test.js
python3 -m unittest scripts/video-ingest/test_transcribe.py
```

- [ ] **Step 2: Validate generated manifest**

确认 23 条、无绝对路径、无重复、所有视频 H.264 + AAC、字幕 ready 的 intro 均 reviewed 且不超过 400 字、所有远端记录仍 draft。

- [ ] **Step 3: Check repository cleanliness**

```bash
git status --short
git ls-files | rg '\.(mp4|wav|m4a|jpg|png)$'
```

不得出现 prepared 视频、音频、关键帧或密钥；保留用户原有未跟踪 unified-search spec，不纳入本功能提交。

- [ ] **Step 4: Commit any verification-only documentation corrections**

```bash
git add README.md scripts/video-ingest/README.md
git commit -m "docs: 补充讲解入库验证与运行说明"
```
