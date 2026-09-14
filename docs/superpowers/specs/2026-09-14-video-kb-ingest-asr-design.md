# 讲解入库与口播转写（方案 A）

状态：待审查。通过后再写实现计划与业务代码。  
分支：`dev-video-kb-ingest`（从 `dev` 迁出）  
对照：总 spec 播放页 `video_doc`；`docs/superpowers/specs/2026-09-13-unified-search-context-hub-design.md`（search / agent 本分支不实现）。

**落地顺序：** 先把本批 mp4 变成可上架的 `videos` 草稿（含播放用媒体与运营文案），再线下转写写入已有 `transcript*`。不把视频二进制送给多模态 API。不在本分支做 `search` / `agent` 云函数。

## 1. 要解决什么

本地目录 `/Users/forsertree/Downloads/视频合集` 有中海达 / 南方 / 司南讲解片。现网 `videos` 已能存标题、简介、标签、封面、视频 fileId，以及 `searchAbstract` / `transcript` / `transcriptSegments` / `entities`。上架不强制转写。

播放页问答要答「点哪个菜单、第几步」，依据是口播文本，不是 H.264 参数。编码信息（时长、分辨率、音轨）只服务播放与入库质检。

因此分两期，仍是同一条产品线：

| 期 | 产出 | 问答能否用 |
| --- | --- | --- |
| A1 入库 | 云存储文件 + `videos` **草稿**（运营字段 + 媒体元数据） | 只能复述标题/简介/标签 |
| A2 转写 | 同记录写入 `transcript` 与带秒数的 `transcriptSegments` | `video_doc` 可按当前播放秒引用口播 |

C 端仍只看到 `status=published`。本批默认 **不自动上架**；运营在管理端核对封面、品牌、简介后再 `publishVideo`。

## 2. 本批片子的处理规则

扫描结果（2026-09-14）：25 个 mp4，全部有 AAC 立体声音轨。多数 H.264 720p@30。

锁定规则：

1. **去重：** `中海达/中海达点测量_副本.mp4` 与 `中海达点测量.mp4` 字节相同 → 只入库正片，丢副本。
2. **同题不同编码：** `中海达主机固件升级_副本.mp4` 为 HEVC 1080p@60；正片为 H.264 720p。小程序入库 **只收 H.264 正片**，副本不入库。
3. **错放目录：** `司南/南方参数计算.mp4` 按文件名归属品牌 **南方**（不建在司南下）。若运营确认是司南内容，只改 `brandId`，不改本规则的默认。
4. **HEVC 须转码后再上传：** `南方/南方数据导出.mp4`、`南方/南方面测量.mp4`。目标：H.264 + AAC、宽边不超过 1280、`+faststart`。原片保留在本地，不覆盖 Downloads 源文件。
5. **其余 H.264 片** 可直接上传；封面用 ffmpeg 抽第 1 秒 JPEG（若第 1 秒黑场，改抽第 3 秒）。

入库标题用去扩展名后的文件名（去掉首尾空格，如 `南方手簿有线升级 .mp4` → `南方手簿有线升级`）。简介、标签、`entities.actions` 用本 spec 附录的运营草案；`modelName` 本批多数为空（文件名未给具体主机型号），C10 那条 `modelName=C10`。

品牌记录：若库中尚无「中海达」「南方」「司南」，入库脚本先 `upsert` 品牌再挂 `brandId`。不在本批创建 `shop_products` 或 `video_shop_links`。

## 3. 数据模型（只加媒体字段，转写用现网字段）

`upsertVideo` 继续写现有文案与 `transcript*`。本分支 **新增** 并持久化：

```text
durationSec: number        // 秒，一位小数即可，来自 ffprobe
media: {
  videoCodec: string       // 入库文件实际编码，转码后应为 h264
  audioCodec: string       // 期望 aac
  width: number
  height: number
  fps: number
  hasAudio: boolean        // 无音轨则 A2 跳过 ASR，简介仍可上架
  sourceBytes: number      // 实际上传文件大小
}
```

不把本地绝对路径、OPENID、ASR 厂商密钥写入集合。`searchBlob` 仍由现网 `buildSearchBlob` 拼接；有转写后自动纳入，无需第二套搜索字段。

`transcriptSegments` 形状固定为：

```text
[{ startSec: number, endSec: number, text: string }]
```

约束：`startSec >= 0`，`endSec > startSec`，按 `startSec` 升序，`text` 去首尾空白；单段 `text` 超过 80 字则按 `。！？；` 再切，子段时间按字符数占原段比例线性分配。整段 `transcript` 为各段 `text` 以换行拼接，供关键词 blob 使用。

A2 未跑完时：`transcript` 与 `transcriptSegments` 保持空数组/空字符串，**允许** A1 草稿存在。

## 4. 信息流

```text
Downloads/视频合集
  → 质检（去重 / HEVC 转码 / ffprobe）
  → 抽封面 JPEG
  → 云存储 video/* 与 cover/* （得 fileId）
  → catalog upsertVideo（draft + durationSec + media + 运营文案）
  → 管理端人工核对 → publishVideo

A2（可晚于上架）：
  本地抽音频 → ASR → 规范化 segments → upsertVideo 只更新 transcript*
  → searchBlob 重建（现网保存逻辑已做）
```

上传与写库走与管理端相同的云开发环境。本机脚本需要 **已登录的 CloudBase / 微信云开发凭据**（环境变量或 CLI，不进仓库）。没有凭据时，脚本停在「产出转码文件 + 封面 + 草稿 JSON」，由运营用管理页上传。禁止把 mp4 提交进 git。

ASR 在开发机跑，不进云函数：云函数超时与体积都不适合中文转写模型。模型文件不进仓库。默认引擎：本机 `faster-whisper`，模型 `medium`，`language=zh`。输出必须变成上一节的 segments 契约。失败的片子保持无转写，不阻断其它片的 A1。

播放页问答（其它分支）使用方式（本分支只保证字段就绪）：

- 注入当前片 `title` / `intro` / `tags` / `brandName` / `modelName` / `searchAbstract`
- 若有 `transcriptSegments`：用请求里的 `currentTimeSec`（缺省当 0）取重叠区间 **[t-15s, t+15s]** 的段落，上限约 800 字；没有进度则取片头 60 秒内段落
- 仍遵守 `video_doc`：不读其它 `videoId` 的转写

不外发：视频、封面、音频二进制。转写文本与运营简介视为可进后续 embeddings 的 `chunk.text`（L2 仍不在本分支）。

## 5. 验收 / 明确不做

**A1**

- 本批有效片均有对应 `videos` 草稿：有 `videoFileId`、`coverFileId`、非空 `title`/`intro`/`brandId`、`durationSec`、`media.hasAudio`
- 未入库两份点测量；未入库 HEVC 主机升级副本
- `南方参数计算` 挂南方
- 源目录与仓库均不出现大体积 mp4 提交
- 未调用 `publishVideo`（除非运营在管理端另行发布）

**A2**

- 有音轨的入库片能生成合法 `transcriptSegments`，时间落在 `[0, durationSec]`
- 抽检：任意一条「点测量」转写含测量相关词，而不是空串或纯噪声
- 无音轨或 ASR 失败：记录保持可播放草稿/上架态，不写假字幕

**不做**

- `search` / `agent` 云函数与播放页对话 UI
- 把 mp4/帧送给视频理解 API
- 云函数内实时 ASR
- 本批商品关联、自动上架、向量库 `search_chunks`
- 按播放进度 seek 到章节（`currentTimeSec` 只作文本上下文）

## 6. 已拍板

1. 走方案 A：先入库媒体与运营文案，再线下转写。
2. 问答知识载体是字幕段，不是编码元数据。
3. `南方参数计算` 默认品牌南方。
4. 小程序只收 H.264+AAC；HEVC 先转码。
5. 本批默认草稿，人工发布。
6. A2 默认 `faster-whisper` + `medium` + `language=zh`。

## 附录：运营草案（A1 写入 intro / tags / entities.actions）

简介可在管理端改；A1 用下列中文短句，避免空 intro 导致无法保存。

| 品牌 | 标题 | tags | intro |
| --- | --- | --- | --- |
| 中海达 | 中海达主机固件升级 | 固件,升级,主机 | 演示中海达主机固件升级入口与流程。 |
| 中海达 | 中海达导入 | 导入,数据,手簿 | 演示把数据导入中海达手簿。 |
| 中海达 | 中海达手簿无线升级 | 手簿,升级,无线 | 演示中海达手簿无线升级。 |
| 中海达 | 中海达手簿有线升级 | 手簿,升级,有线 | 演示中海达手簿有线升级。 |
| 中海达 | 中海达点测量 | 点测量 | 演示中海达点测量作业步骤。 |
| 中海达 | 中海达线测量 | 线测量 | 演示中海达线测量作业步骤。 |
| 中海达 | 中海达面测量 | 面测量 | 演示中海达面测量作业步骤。 |
| 南方 | 南方C10手簿软件升级 | C10,手簿,升级 | 演示南方 C10 手簿软件升级。 |
| 南方 | 南方CORS设置 | CORS,差分,网络 | 演示南方手簿 CORS 连接与账号设置。 |
| 南方 | 南方主机升级无线 | 固件,升级,无线 | 演示南方主机无线升级固件。 |
| 南方 | 南方主机固件升级有线 | 固件,升级,有线 | 演示南方主机有线升级固件。 |
| 南方 | 南方手簿有线升级 | 手簿,升级,有线 | 演示南方手簿有线升级。 |
| 南方 | 南方数据导入 | 导入,数据 | 演示南方手簿数据导入。 |
| 南方 | 南方数据导出 | 导出,数据 | 演示南方手簿数据导出。 |
| 南方 | 南方点测量 | 点测量 | 演示南方点测量作业步骤。 |
| 南方 | 南方面测量 | 面测量 | 演示南方面测量作业步骤。 |
| 南方 | 南方参数计算 | 参数,坐标 | 演示南方参数计算流程。 |
| 司南 | 司南手簿无线 | 手簿,升级,无线 | 演示司南手簿无线升级。 |
| 司南 | 司南手簿有线 | 手簿,升级,有线 | 演示司南手簿有线升级。 |
| 司南 | 司南数据导入 | 导入,数据 | 演示司南数据导入。 |
| 司南 | 司南点测量 | 点测量 | 演示司南点测量作业步骤。 |
| 司南 | 司南线测量 | 线测量 | 演示司南线测量作业步骤。 |
| 司南 | 司南面测量 | 面测量 | 演示司南面测量作业步骤。 |
