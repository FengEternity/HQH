# 讲解入库与口播转写（方案 A）

状态：待审查。通过后再写实现计划与业务代码。  
分支：`dev-video-kb-ingest`（从 `dev` 迁出）  
对照：总 spec 播放页 `video_doc`；`docs/superpowers/specs/2026-09-13-unified-search-context-hub-design.md`（search / agent 本分支不实现）。

**落地顺序：** 先把本批 mp4 变成可上架的 `videos` 草稿（含播放用媒体与运营文案），再线下转写写入 `transcriptSegments`（全文由保存逻辑派生）。不把视频二进制送给多模态 API。不在本分支做 `search` / `agent` 云函数。

## 1. 要解决什么

本地目录 `/Users/forsertree/Downloads/视频合集` 有中海达 / 南方 / 司南讲解片。现网 `videos` 已能存标题、简介、标签、封面、视频 fileId，以及 `searchAbstract` / `transcript` / `transcriptSegments` / `entities`。上架不强制转写。

播放页问答要答「点哪个菜单、第几步」，依据是口播文本，不是编码参数。编码信息只服务播放与入库质检。

现网把可搜文本叠了多层（简介、摘要、标签、entities、全文、分段、再加 `searchBlob`）。本分支 **不删列**（避免和已上架数据、旧客户端抢字段），但 **写入时收敛**：只填事实源，派生字段由 `upsertVideo` 重算，禁止同一批关键词写三遍。

分两期：

| 期 | 产出 | 问答能否用 |
| --- | --- | --- |
| A1 入库 | 云存储文件 + `videos` **草稿**（占位 intro + 最小媒体元数据） | 只能复述标题/占位简介/标签 |
| A2 转写 | 写入 `transcriptSegments`；用口播 + **本地**关键帧重写 `intro`；`transcript` / `searchBlob` 保存时生成 | `video_doc` 用 intro 看全片步骤，用分段对齐当前秒 |

C 端仍只看到 `status=published`。本批默认 **不自动上架**；运营在管理端核对封面、品牌、简介后再 `publishVideo`。

## 2. 本批片子的处理规则

扫描结果（2026-09-14）：25 个 mp4，全部有 AAC 立体声音轨。多数 H.264 720p@30。

锁定规则：

1. **去重：** `中海达/中海达点测量_副本.mp4` 与 `中海达点测量.mp4` 字节相同 → 只入库正片，丢副本。
2. **同题不同编码：** `中海达主机固件升级_副本.mp4` 为 HEVC 1080p@60；正片为 H.264 720p。小程序入库 **只收 H.264 正片**，副本不入库。
3. **错放目录：** `司南/南方参数计算.mp4` 按文件名归属品牌 **南方**（不建在司南下）。若运营确认是司南内容，只改 `brandId`，不改本规则的默认。
4. **HEVC 须转码后再上传：** `南方/南方数据导出.mp4`、`南方/南方面测量.mp4`。目标：H.264 + AAC、宽边不超过 1280、`+faststart`。原片保留在本地，不覆盖 Downloads 源文件。
5. **其余 H.264 片** 可直接上传；封面用 ffmpeg 抽第 1 秒 JPEG（若第 1 秒黑场，改抽第 3 秒）。

入库标题用去扩展名后的文件名（去掉首尾空格，如 `南方手簿有线升级 .mp4` → `南方手簿有线升级`）。A1 的 intro 与标签用附录占位；**不写** `searchAbstract`、**不写** `entities`。A2 完成后用口播+关键帧**覆盖** intro（见 §3.4）。`modelName` 本批多数为空，仅 `南方C10手簿软件升级` 填 `C10`。

品牌记录：若库中尚无「中海达」「南方」「司南」，入库脚本先 `upsert` 品牌再挂 `brandId`。不在本批创建 `shop_products` 或 `video_shop_links`。

## 3. 数据模型：事实源 vs 派生

### 3.1 本分支写入的事实源

| 字段 | 职责 |
| --- | --- |
| `title` / `tags` | 卡片与管理端；tags 是本批唯一关键词列表 |
| `intro` | A1 为占位一句；A2 起是按步骤写的操作说明（§3.4），不是固定长文 |
| `brandId` | 品牌关联；`brandName` 保存时从 `brands` 冗余过来（现网已有，不改） |
| `productId` / `modelName` | 可选型号；本批仅 C10 填 `modelName`，不挂 `productId` |
| `coverFileId` / `videoFileId` | 云存储资产 |
| `status` 及时间戳 | 生命周期；A1 为 `draft` |
| `transcriptSegments` | A2 口播事实源：`[{ startSec, endSec, text }]` |
| `durationSec` | 秒，一位小数；字幕窗口上界与质检 |
| `media.videoCodec` / `media.audioCodec` / `media.hasAudio` | 入库文件实际编码；无音轨则跳过 A2。不把宽高、fps、体积写入集合（留在本地质检日志即可） |

`transcriptSegments` 约束：`startSec >= 0`，`endSec > startSec`，按 `startSec` 升序，`text` 去首尾空白；单段超过 80 字则按 `。！？；` 再切，子段时间按字符数占原段比例线性分配。

### 3.2 派生（禁止当第二份手写稿）

| 字段 | 规则 |
| --- | --- |
| `searchBlob` | 仍由现网 `buildSearchBlob` 在每次 `upsertVideo` 重算。这是允许存在的检索缓存，不是业务事实。 |
| `transcript` | **只从** 当前 `transcriptSegments` 的 `text` 换行拼接。请求体若另带全文且与分段不一致 → `BAD_INPUT`。A1 无分段时两者皆空。 |
| `brandName` | 继续从品牌文档回填（现网逻辑）。 |

### 3.3 本批明确留空（列保留，不灌数据）

| 字段 | 原因 |
| --- | --- |
| `searchAbstract` | 与 `intro` 重叠；intro 已承担「这段在讲什么」。只有日后 intro 过口语、检索词藏不住时再填。 |
| `entities` | 与 `tags` 重叠，且管理端无表单。保持默认 `{ models, actions, menus, aliases: [] }`。真有菜单名/别名再填。 |

不把本地绝对路径、OPENID、ASR 密钥写入集合。不把 `media` 拼进 `searchBlob`。

### 3.4 A2 之后的 intro：按步骤伸缩，不设 300 字起步

口播是证据；intro 是步骤目录。关键帧只在**开发机**抽取（镜头变化或约 5～10 秒一帧），用来看清按钮名，**不上传、不进 git、不注入 `video_doc` 运行时**。封面仍只一张。禁止把关键帧发给云端多模态 API。

写法：从字幕里分出操作步骤，**每步一句**（动作 + 界面要点；口播或关键帧里出现过的名字才能写）。可在句末标大约秒数，方便和分段对齐。口播没有、帧上也看不清的，不编。

篇幅随内容变，不按「300～800 字」灌：

- 短片两三个动作 → 几十字到一百多字是正常的（本批大量 40～70 秒升级/导入片走这条）
- 步骤多的长片 → 句子随步骤增加
- **上限 400 字**：再多的细节只留在 `transcriptSegments`，让问答按当前秒去取，不把播放页简介写成说明书

A1 附录占位在 A2 成功后必须被这篇步骤说明覆盖。ASR 失败则保留占位 intro，不强行写长文。

实现时改 `upsertVideo`：在 `buildSearchBlob` 之前用分段生成 `transcript`；本批入库脚本不传 `searchAbstract` / `entities`（走现网空默认）。管理端保存若未带这两项，继续保留库中旧值（兼容已有记录），**新草稿**不得被脚本写成摘要/entities 副本。

## 4. 信息流

```text
Downloads/视频合集
  → 质检（去重 / HEVC 转码 / ffprobe）
  → 抽封面 JPEG
  → 云存储 video/* 与 cover/* （得 fileId）
  → catalog upsertVideo（draft + durationSec + 最小 media + title/intro/tags）
  → 管理端人工核对 → publishVideo

A2（可晚于上架）：
  本地抽音频 → ASR → 规范化 segments
  → 本地抽关键帧（不上传）→ 按步骤写 intro 覆盖占位
  → upsertVideo 带 transcriptSegments + 新 intro
  → 服务端生成 transcript 并重建 searchBlob
```

上传与写库走与管理端相同的云开发环境。本机脚本需要 **已登录的 CloudBase / 微信云开发凭据**（环境变量或 CLI，不进仓库）。没有凭据时，脚本停在「产出转码文件 + 封面 + 草稿 JSON」，由运营用管理页上传。禁止把 mp4 提交进 git。

ASR 在开发机跑，不进云函数。模型文件不进仓库。默认引擎：本机 `faster-whisper`，模型 `medium`，`language=zh`。输出必须是 `transcriptSegments`。失败的片子保持无转写，不阻断其它片的 A1。

播放页问答（其它分支）使用方式（本分支只保证字段就绪）：

- 注入当前片 `title` / `intro`（步骤说明，可短可长） / `tags` / `brandName` / `modelName`；`searchAbstract` 为空则不注入；不注入关键帧图片
- 若有 `transcriptSegments`：用请求里的 `currentTimeSec`（缺省当 0）取重叠区间 **[t-15s, t+15s]** 的段落，上限约 800 字；没有进度则取片头 60 秒内段落
- 仍遵守 `video_doc`：不读其它 `videoId` 的转写

不外发：视频、封面、音频二进制。转写文本与运营简介视为可进后续 embeddings 的 `chunk.text`（L2 仍不在本分支）。

## 5. 验收 / 明确不做

**A1**

- 本批有效片均有对应 `videos` 草稿：有 `videoFileId`、`coverFileId`、非空 `title`/`intro`/`brandId`、`durationSec`、`media.hasAudio`
- `searchAbstract` 为空字符串；`entities` 四桶皆空；关键词只在 `tags`
- 未入库两份点测量；未入库 HEVC 主机升级副本
- `南方参数计算` 挂南方
- 源目录与仓库均不出现大体积 mp4 提交
- 未调用 `publishVideo`（除非运营在管理端另行发布）

**A2**

- 有音轨的入库片能生成合法 `transcriptSegments`，时间落在 `[0, durationSec]`
- 同记录 `transcript` 等于分段 `text` 换行拼接，无第三份手写全文
- A2 成功后 intro 已覆盖附录占位，且能按步骤点名片中出现过的操作；字数随步骤数变化，**不**以满 300 字为验收
- 抽检：任意一条「点测量」转写含测量相关词；对应 intro 短于 400 字
- 无音轨或 ASR 失败：记录保持可播放草稿/上架态，不写假字幕，intro 可仍为占位
- 仓库与云存储不出现「除封面外」的关键帧文件清单作为问答素材

**不做**

- `search` / `agent` 云函数与播放页对话 UI
- 把 mp4/关键帧送给云端视频理解 API；运行时 `video_doc` 带图
- 把 intro 写成固定 300～800 字散文
- 云函数内实时 ASR
- 本批商品关联、自动上架、向量库 `search_chunks`
- 按播放进度 seek 到章节（`currentTimeSec` 只作文本上下文）
- 新增 `searchKeywords` 等平行关键词列；不把宽高/fps/体积写入 `videos`

## 6. 已拍板

1. 走方案 A：先入库媒体与运营文案，再线下转写。
2. 问答知识载体是字幕段，不是编码元数据。
3. `南方参数计算` 默认品牌南方。
4. 小程序只收 H.264+AAC；HEVC 先转码。
5. 本批默认草稿，人工发布。
6. A2 默认 `faster-whisper` + `medium` + `language=zh`。
7. 事实源：卡片文案、fileId、`brandId`、分段字幕、最小 `media`。`searchBlob` / `transcript` / `brandName` 为派生。
8. 本批不填 `searchAbstract` 与 `entities`；动作类词只进 `tags`。
9. A2 用口播 + 本地关键帧重写 intro：每步一句，篇幅随步骤数变；上限 400 字；帧不外发、不入库（封面除外）。

## 附录：运营草案（A1 占位 intro / tags）

仅保证保存闸门；A2 成功后必须换成 §3.4 的步骤说明，不要把本表当问答知识库。

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
