# 运营上传后自动填写讲解草稿

状态：已通过。实现按 `docs/superpowers/plans/2026-09-15-ops-upload-auto-ingest.md`。  
对照：`docs/superpowers/specs/2026-09-14-video-kb-ingest-asr-design.md`（本地批处理契约）；播放页 `video_doc` 仍不在本设计实现。

**产品：** 运营只上传一条讲解视频（上传入口仍挂在某个品牌下，点一次品牌即可）。后台自动填写字幕、步骤简介、时长与编码。运营改完点「确认上架」才 `publishVideo`。生成成功不等于入库。

## 1. 要解决什么

现网管理端是「先填标题/简介，再传视频」。本地脚本能转写，但不能在运营点上传之后自己跑。

云函数超时短、无 GPU，不能在 `upsertVideo` 里做 ASR。需要：

1. 上传后立刻有一条 C 端不可见的草稿壳
2. 云函数外的 worker 异步填字段
3. 管理端能看出处理到哪一步、失败能否重试
4. 运营改稿与 worker 回写不要互相覆盖

不外发视频/封面/音频/关键帧二进制。转写仍优先在自建 worker 上用 `faster-whisper`（或同口径的 FunASR）。不把画面交给云端多模态。

## 2. 为什么不是 `processed: true`

现网 `videos.status` 只表示 C 端生命周期：`draft` / `published` / `unpublished`。**不要**再用它表示「转写过没有」。

也不要单个布尔 `processed` / `hasTranscript`：

| 实际情况 | 布尔值会怎样 |
| --- | --- |
| 排队、转写中、成功、失败、无音轨跳过 | 挤成一个 true/false，列表无法筛选 |
| 运营换了 `videoFileId` | true 会撒谎，旧字幕挂在新片上 |
| ASR 成功但 intro 仍占位 | 「处理过」说不清要不要给人核对 |
| 运营已改 intro，worker 重跑 | 不知道该不该覆盖文案 |

需要的是 **处理状态机 + 和这次文件绑定的版本**，给管理端展示；队列抢锁可以另放任务表，不要把 worker 内部日志堆进播放文档。

## 3. 数据模型

### 3.1 `videos.ingest`（管理端事实，C 端不返回）

挂在视频文档上。`publicVideo()` / `getVideo` **不得**带出该对象。历史文档无此字段视为 `phase=idle`（从未走自动处理，或上线前已人工填好）。

```text
ingest: {
  phase: 'idle' | 'queued' | 'running' | 'ready' | 'failed',
  mediaRevision: number,          // 每次 videoFileId 变化 +1；worker 必须带同一值回写
  videoFileId: string,            // 入队时的文件；回写时不一致则丢弃结果
  asr: 'pending' | 'ready' | 'skipped' | 'failed',
  introSource: 'placeholder' | 'auto' | 'human',
  errorCode: string,              // 仅 failed；稳定枚举，见 §3.3
  errorMessage: string,           // 给人看的短句，不含密钥与本地路径
  queuedAt: number,
  startedAt: number,
  finishedAt: number,
  attempt: number
}
```

`phase` 对人：

| phase | 管理端 | worker |
| --- | --- | --- |
| `idle` | 未排队（旧数据或未点上传） | 不抢 |
| `queued` | 处理中 | 可领取 |
| `running` | 处理中 | 已领取；超时可再领 |
| `ready` | 待核对 | 默认不再跑；换片或运营点重试才再入队 |
| `failed` | 失败，可重试 | 不自动连跑 |

`asr` 与 `phase` 分开：无音轨时 `phase=ready` 且 `asr=skipped`，分段保持空数组，intro 保持占位。不要把「没声音」写成失败，以免运营以为要重试模型。

`introSource`：

- `placeholder`：壳上的固定占位句，worker **可以**覆盖
- `auto`：本轮 worker 写的步骤 intro，运营未改；重试仍可覆盖
- `human`：运营保存过 intro；worker **禁止**覆盖 intro，仍可更新字幕（重试转写时）

运营保存标题/标签/品牌不改变 `introSource`。只有请求里带了与库中不同的 `intro` 才标 `human`。

`transcript` / `searchBlob` / `brandName` 仍是派生字段，规则与 2026-09-14 spec 相同。本设计不新增 `searchAbstract` / `entities` 的自动填写。

### 3.2 任务表 `video_ingest_jobs`（抢锁，不给 C 端）

只服务 worker 领取，避免两台机器同时转同一条。字段尽量少：

```text
{
  videoId,
  mediaRevision,
  phase: 'queued' | 'running' | 'done' | 'dead',
  claimedAt, claimedBy,          // claimedBy 为 worker 实例名，不是 OPENID
  createdAt, updatedAt
}
```

完成或放弃后把任务标 `done` / `dead`，**最终对人可见的状态以 `videos.ingest` 为准**。不要把字幕正文复制进任务表。

列表、详情、上架闸门只读 `videos`。任务表坏了可以按 `ingest.phase=queued|running` 重建，不能让播放数据依赖它。

### 3.3 失败码（允许列表）

`NO_AUDIO` 不算失败（走 skipped）。`failed` 仅这些：

- `DOWNLOAD_FAILED`
- `TRANSCODE_FAILED`
- `ASR_FAILED`
- `INTRO_NOT_GROUNDED`（字幕在，但自动 intro 过不了取证闸门 → 保留字幕，intro 仍占位，`phase=ready`，`introSource=placeholder`，**这条其实不是 failed**；见下）
- `INTERNAL`

自动 intro 取证失败：当成部分成功，`phase=ready`，`asr=ready`，intro 不写假步骤。管理端文案：「字幕已出，简介需手写」。不要因此让运营点「重试 ASR」。

`TRANSCODE_FAILED`：源片不是可播的 H.264+AAC 且 worker 转码失败。草稿仍留着原 `videoFileId`，上架按钮可继续用现网规则（有封面+视频即可），但应提示编码可能不适配小程序。

禁止把栈、临时路径、云密钥写入 `errorMessage`。

## 4. 信息流

```text
管理端（已选 brandId）
  → 选 mp4，wx.cloud.uploadFile
  → 建/更新草稿壳：title=文件名，intro=占位句，cover=首帧或后补
     ingest.phase=queued，mediaRevision++，asr=pending，introSource=placeholder
  → 写入 video_ingest_jobs
  → 返回；上传接口不空等转写

Worker（云托管或小机器，轮询任务表）
  → 抢锁 phase=running
  → 下载 videoFileId；校验仍等于 ingest.videoFileId 与 mediaRevision
  → ffprobe；必要时先转 H.264+AAC 并回传新 fileId（见 §5），无音轨也先转可播编码
  → 无音轨：asr=skipped，phase=ready，结束（不跑 ASR）
  → ASR → 规范化 transcriptSegments
  → 本地抽关键帧（不上传）→ 规则生成 intro
      取证过：introSource=auto
      取证不过：不改 intro，introSource 保持 placeholder
      若此时库中 introSource 已是 human：不改 intro
  → catalog 管理接口回写（与 upsert 同一套校验）
  → ingest.phase=ready，任务 done

运营打开草稿
  → 改标题/品牌/简介/标签/封面/错字字幕
  → 保存；改 intro 则 introSource=human
  → 确认上架 → publishVideo（现网内容安全检测仍走）
```

`queued` / `running` 时管理端 **禁用上架**，避免处理中 intro 被覆盖、C 端闪现占位句。`ready` / `failed` / `idle` 仍按现网上架闸门（标题、简介、品牌、封面、视频）。字幕不是上架前置条件。

## 5. 草稿壳与现网闸门

现网 `assertVideoDraftFields` 要求标题、品牌、简介非空。壳用一条固定占位 intro，例如：`讲解处理中，完成后请核对简介。`（实现时抽成常量，管理端按 `introSource=placeholder` 展示「待生成」，不要引导运营把这句当成品。）

上传入口：从品牌列表进编辑页，**仍带 `brandId`**。不在本设计做「未分类品牌」。型号、标签允许空，worker 第一期 **不猜品牌、不猜 tags**（口播猜标签误差大，留给运营）。

若运营在 `running` 时保存简介：标 `human`，worker 回写跳过 intro，仍写字幕。

若运营在处理中途换了视频：`mediaRevision+1`，旧任务结果丢弃，新任务入队；旧字幕清空，避免张冠李戴。

Worker 若必须转码：先把新 mp4 传到云存储，再更新 `videoFileId` 与 `ingest.videoFileId`，但同一任务内 **不递增** `mediaRevision`；它仍是同一源视频的兼容格式产物，当前任务继续完成 ASR。只有运营主动换片才递增 revision，使旧任务结果失效。

封面：上传时能拿到微信缩略图就先存；没有则 worker 抽第 1 秒 JPEG（黑场则第 3 秒），仅当 `coverFileId` 仍空时回写。运营已选封面则不覆盖。

## 6. 接口（catalog，均需管理员票）

| action | 谁调用 | 做什么 |
| --- | --- | --- |
| `upsertVideo` | 管理端 | 保存文案；若 `videoFileId` 变化则入队（见 §4） |
| `enqueueVideoIngest` | 管理端「重新处理」 | 仅 `failed` 或 `ready`（换模型/重跑）可入队；`queued`/`running` 拒绝 |
| `claimVideoIngest` / `completeVideoIngest` | worker | 抢锁与回写；用服务票或现有 `ADMIN_PIN` 票，**不**把 PIN 打进小程序 |

具体方法名实现时可合并进现有 `upsertVideo` 的服务端路径，但必须有「仅 worker 能写 `transcriptSegments` + `ingest.phase`」的鉴权面，避免普通保存把 phase 随表单清掉。

管理端 `adminListVideos` / `adminGetVideo` 返回 `ingest`（至少 `phase`、`asr`、`introSource`、`errorMessage`）。

## 7. Worker 部署口径

第一期：一台能跑 ffmpeg + faster-whisper 的常驻进程，轮询 `video_ingest_jobs`。可以就是现在 `scripts/video-ingest/` 加上「拉云存储、写回 catalog」。

不做：云函数内 ASR、把 mp4 交给第三方视频理解、自动 `publishVideo`、自动填 `entities`/`searchAbstract`、播放页对话。

凭据只在运行环境：`TCB_ENV_ID` / `TCB_SECRET_ID` / `TCB_SECRET_KEY` / `ADMIN_PIN`（或后续独立 worker 密钥）。不进仓库。

## 8. 验收

- 运营在某品牌下只传 mp4，可得到草稿；C 端搜不到
- 列表能区分排队中 / 待核对 / 失败 / 无音轨跳过
- 成功后有合法 `transcriptSegments`，`transcript` 与分段一致；intro 或为取证通过的步骤句，或仍为占位
- 运营改过的 intro，重试 ASR 后不被覆盖
- 换视频后旧字幕不会留在新 `videoFileId` 上
- `getVideo` 无 `ingest` 字段
- 处理中不能上架；`ready` 且现网字段齐全可以上架
- 无真实云密钥时，单测不打云，用假任务表与假存储

## 9. 已拍板

1. C 端 `status` 与处理进度分离；处理进度用 `videos.ingest`，不是布尔值。
2. 任务表只负责抢锁；对人展示以 `videos.ingest` 为准。
3. 上传仍选品牌；简介用占位句过现网必填闸门。
4. 不自动上架；`queued`/`running` 禁止上架。
5. 画面与音视频二进制不外发；ASR 在自建 worker。
6. 第一期不自动猜 tags/品牌。
7. 运营改 intro 后 worker 不再覆盖 intro。
8. 本设计不实现 `search` / `agent` / `video_doc` 运行时。
