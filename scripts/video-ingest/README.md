# 讲解视频入库脚本

本目录的脚本在本机完成视频预处理、转写、介绍审核和云端草稿导入。要求 Node.js 18+；CloudBase SDK 依赖仅安装在本目录：

```bash
npm ci --ignore-scripts --prefix scripts/video-ingest
```

当前 lock 固定 `@cloudbase/node-sdk 3.18.3`。截至本次验证，`npm ci` 的依赖审计报告为 **1 个 moderate、4 个 high** 传递依赖风险；不要据此声称依赖无漏洞，也不要盲目运行可能引入破坏性变更的 `npm audit fix --force`。该脚本只供受控本机运营使用，每次 `--execute` 前都应重新评估风险，并优先验证可用的 SDK 升级。

## 本地准备流程

令 `INPUT_DIR` 指向用户明确提供的本地视频目录。预处理输出必须留在已忽略的 `.video-ingest/prepared`：

```bash
node scripts/video-ingest/preprocess.js \
  --input "$INPUT_DIR" \
  --output .video-ingest/prepared
```

### 换新目录先补运营草案

`content.zh-CN.json` 按「去扩展名并去首尾空格的文件名」登记每个标题的 `tags` / `intro` / `modelName`。遇到未登记的标题，`preprocess` 抛出 `缺少运营草案：<标题>` 并**整批中止**，不会写出 manifest，也不会只跳过这一条。先把新标题补进 `content.zh-CN.json` 再重跑，不要为了跑通而放宽校验或临时编一条占位文案。

排除哪些片子同样是项目规则，不是脚本自动判断：

- 字节完全相同的重复文件按内容哈希去重，正片优先于 `_副本`。
- `中海达主机固件升级_副本` 这类「同题不同编码」的副本与正片哈希不同，只能靠 `lib/manifest.js` 里写死的排除清单剔除。
- `司南/南方参数计算.mp4` 按文件名归到南方，也是写死的归属规则。

脚本不做语义去重。换一批素材时要人工复核这些清单，需要变更就改代码并补测试。

首次运行 ASR 时，创建独立虚拟环境并在该环境安装依赖：

```bash
python3 -m venv .video-ingest/venv
.video-ingest/venv/bin/pip install \
  -r scripts/video-ingest/requirements-asr.txt
```

后续转写统一使用该虚拟环境；已为 `ready` 的条目默认跳过：

```bash
.video-ingest/venv/bin/python scripts/video-ingest/transcribe.py \
  --manifest .video-ingest/prepared/manifest.json \
  --model medium \
  --language zh
```

## 自动处理 worker

worker 在云函数外运行，轮询 `catalog` 领取任务，并在本机完成下载、`ffprobe`、必要的 H.264+AAC 转码及 faster-whisper 转写。它不会调用 `publishVideo`，也不会把视频、音频或帧发送给第三方服务。

启动前需在进程环境中配置 `TCB_ENV_ID`、`TCB_SECRET_ID`、`TCB_SECRET_KEY`、`ADMIN_PIN`，值不要写入仓库或命令行。默认使用 `.video-ingest/venv/bin/python` 和 `medium` 模型；如需覆盖，可只设置环境变量名 `VIDEO_INGEST_PYTHON`、`VIDEO_INGEST_ASR_MODEL`，不要把本机模型文件路径提交到 git。

```bash
# 需本机已配置 TCB_* 与 ADMIN_PIN
node scripts/video-ingest/worker.js
```

worker 无任务时每 5 秒重试。每个任务使用独立临时目录，并在成功或异常后清理下载、转码及临时 manifest；转码产物上传后仍在原任务、原 `mediaRevision` 内完成。

人工或 agent 根据字幕与仅限本地查看的关键帧完成 `intros.review.json` 后，应用审核稿：

```bash
node scripts/video-ingest/apply-intros.js \
  --manifest .video-ingest/prepared/manifest.json \
  --reviews .video-ingest/prepared/intros.review.json
```

### intro 证据闸门

`apply-intros` 把 intro 按 `。！？；` 切成步骤句逐句取证，不是「整篇命中一个词就放行」：

- 每一句都必须有出处：要么句内有至少三个连续汉字（或含字母的型号词）能在本条字幕里找到，要么句中出现审核稿显式申报的关键帧界面词。
- 命中字幕的句子必须占多数，至少 `ceil(2/3)`；关键帧只能兜住剩下不超过三分之一的界面词。
- `（约第 12 秒）` 这类对齐标注在取证前先剥掉，不能当依据。
- 一句都没命中字幕时直接判 `NOT_GROUNDED`。

需要写屏幕上看得见、但口播没念的界面词时，在该条审核稿加 `keyframeEvidence`：

```json
{
  "reviews": [
    {
      "sourceKey": "…",
      "title": "南方点测量",
      "intro": "点击右下角的测量栏。…屏幕右上角显示存储路径。",
      "keyframeEvidence": ["存储路径"]
    }
  ]
}
```

申报值会随条目写进 manifest 的 `introKeyframeEvidence`，之后没有新审核稿时复核仍按同一份申报判定。关键帧本身只在本机查看：不上传、不进 git、不注入问答、不发给云端多模态 API。这道闸门只能证明「介绍里的词在本条素材里出现过」，**不等于**内容正确，运营仍要人工抽检。

然后按下文先执行 import dry-run；只有所有安全与导入闸门都满足后，才可执行草稿导入。

## 安全边界

- 无云端凭据时，可以运行 `preprocess`、`transcribe`、`apply-intros` 和 `import --dry-run`。
- `import.js` 默认 dry-run；只有显式传入 `--execute` 才会调用云存储和 `catalog`。
- 执行模式只读取进程环境中的 `TCB_ENV_ID`、`TCB_SECRET_ID`、`TCB_SECRET_KEY`、`ADMIN_PIN`。不要把值写进命令、manifest、配置文件或仓库。
- 执行前先确认 `TCB_ENV_ID` 是目标云开发环境，并确认该环境已部署当前版本的 `catalog`。脚本会先通过 `adminLogin` 获取 ticket，再核验并补齐品牌。
- 脚本只调用 `upsertVideo` 保存草稿，绝不调用 `publishVideo`。导入后须到管理端抽检封面、视频、品牌、介绍和字幕，再人工上架。
- 只有 `transcription.status=ready` 且 `introStatus=reviewed` 的条目可导入；缺少本地封面或视频也会拒绝。
- prepared 里的封面与视频会按真实路径复核一次：指向 prepared 根之外的符号链接按缺文件拒绝，不会被上传。
- 字幕必须落在 `[0, durationSec]` 内。任一段 `endSec` 超过时长即判 `TRANSCRIPT_SEGMENT_OUT_OF_RANGE`；云函数 `upsertVideo` 也会用同一条边界再拒一次。

建议通过受控的环境注入工具设置凭据，避免把密钥直接写在 shell 命令行。先运行：

```bash
node scripts/video-ingest/import.js \
  --manifest .video-ingest/prepared/manifest.json \
  --dry-run
```

输出应为脱敏计划，只含相对 prepared 路径和待写草稿 payload。dry-run 中的 `brandId`、`coverFileId`、`videoFileId` 都是占位符，不是可提交给云端的真实值。确认 23 条均可导入后，才可在已验证的目标环境运行：

```bash
node scripts/video-ingest/import.js \
  --manifest .video-ingest/prepared/manifest.json \
  --execute
```

## 幂等与失败恢复

manifest 的 `import` 字段按 `cover`、`video`、`draft` 三个 checkpoint 逐步回写。已成功的 checkpoint 在后续运行中跳过；失败 checkpoint 记录脱敏错误且条目不会标为成功。云端返回草稿 ID 后，条目才写为 `import.status=success`。

**manifest 是 execute 的幂等凭据。** 首次执行前必须备份，执行期间不得删除、覆盖或从旧副本恢复。若 manifest 整体丢失，不可从零重跑 `--execute`，否则脚本无法识别已经上传的文件和已经创建的草稿；应先人工恢复最新备份并核对云端 checkpoint。已有 `draft.videoId` 的失败重试会把该 ID 传回 `upsertVideo`，更新原草稿而不是新增。

调用 `upsertVideo` 前，脚本会先落盘 `draft.status=inflight`。只有云函数返回确定性业务拒绝码（`BAD_INPUT`、`UNAUTHORIZED`、`BAD_PIN`、`NOT_FOUND`、`UNKNOWN_ACTION`、`CONTENT_REJECTED`）才改记 `failed`，因为这些分支必定在写库之前中止，允许修正输入后自动重试。catalog 的兜底 `code: 'FAIL'`、未知错误码、数据库故障，以及缺少响应信封、`ok` 非布尔值、网络异常、超时、成功响应缺少非空字符串 `id`，都无法判断草稿是否已写入，一律保留 inflight。下一次运行看到没有 `videoId` 的 inflight 条目会拒绝自动重试；必须先在管理端核对云端是否已有对应草稿，再人工修复 manifest。若 inflight 已有 `videoId`，则可继续用该 ID 幂等更新。

`tags` 在生成 payload 时统一去首尾空白并去重，与云函数保存前的归一化一致，因此 dry-run 输出的 `tags` 就是云端最终存储值。

单条本地闸门失败不会中止整批：dry-run 和 execute 都会把它列入 rejected，并继续处理其他合法条目；最终汇总返回非零，提醒运营修复被拒绝条目。闸门不会因此放宽。

导入 payload 明确写入空字符串 `searchAbstract` 和四桶为空的 `entities`，口播只传 `transcriptSegments`；不传手写 `transcript`，由 `catalog` 保存逻辑派生。

`preprocess`、`apply-intros`、`import` 写 manifest 都走同一个原子写入：先写 `manifest.json.tmp`（权限 `0600`）再 rename，残留的旧临时文件会先删掉，避免沿用宽松权限。

## 跑测试

```bash
node --test \
  scripts/video-ingest/*.test.js \
  scripts/video-ingest/lib/*.test.js
python3 -m unittest scripts/video-ingest/test_transcribe.py
```

两行 glob 缺一不可：本目录下的 `import` / `preprocess` / `apply-intros` / SDK 冒烟测试和 `lib/` 下的纯函数测试分处两层。仓库全量命令见根 `README.md`。
