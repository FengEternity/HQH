# AI 搜片（本机先行）

日期：2026-08-31  
状态：实现中（2026-08-31）

## 问题

测绘从业者常用问句找片（例如「怎么算参数」「AR 怎么测房」），现有搜索是关键词包含匹配。口播转写已入库，但 ASR 错词多；问句和标题字面往往对不上。

## 目标

在**不接微信云开发**的前提下，小程序提供与普通搜并列的 **AI 搜**：

1. 问句改写（自然语言 → 检索用语）
2. 语义召回（向量匹配片子与口播切片）
3. 跳段落（播放页从命中秒数起播）
4. 一两句说明（基于命中片段，不编造片外知识）

成功标准：

- 问「参数计算怎么做」能排到参数计算相关已上架片，而不是只靠标题里有这三个字
- 有 `transcriptSegments` 的片子，结果带 `startSec`，点进播放页从该秒开始
- 无切片只有全文转写时，仍能召回该片，从 0 秒起播
- 未配置 API 密钥或服务未启动时，明确报错，**不**悄悄改走普通搜
- 列表接口不下发完整 `transcript`

## 非目标

- 微信云函数 / 云向量库
- 根据点击日志训练排序
- 播放页内多轮对话
- 修正 ASR 错词（沿用现有转写；有 `searchAbstract` 时优先用于整片向量）
- 替换现有关键词搜索

## 用户体验

首页搜索行：输入框 +「搜索」（现有关键词）+「AI 搜」。

- 未选品牌时全库搜；选了品牌胶囊则只在该品牌已上架片中召回
- AI 搜结果为卡片网格：封面、标题、模型短说明、口播摘录（约 40 字）、「约 mm:ss」若有跳转秒
- 点卡片：`/pages/player/player?id=…&t=秒`
- 空结果：提示换说法或改用「搜索」
- 失败：toast 或页内文案（服务未开 / 未配密钥 / 上游超时）

播放页读取 `t`，传给 `<video initial-time>`。仍不自动系统全屏。

## 架构

```
小程序 AI 搜  →  POST http://127.0.0.1:8787/api/ai-search
离线索引      →  node scripts/embed-catalog.js → miniprogram/data/ai-index.json
片源服务      →  读 catalog.js + ai-index.json，调 OpenAI 兼容 Chat / Embeddings
```

密钥只在本机环境变量，不进 git、不进小程序包。`ai-index.json` 可提交（向量，无密钥）；若体积过大则 gitignore，本机生成。实现时以「单文件 JSON、当前约 20 片可提交」为默认；单文件超过约 2MB 再改为 gitignore。

### 环境变量

| 变量 | 含义 |
|------|------|
| `OPENAI_BASE_URL` | 兼容网关，如 `https://api.deepseek.com` 或厂商 OpenAI 兼容地址 |
| `OPENAI_API_KEY` | 密钥 |
| `OPENAI_CHAT_MODEL` | 改写与短说明，默认 `deepseek-chat`（若网关不支持则在 README 写明改法） |
| `OPENAI_EMBED_MODEL` | embedding 模型名，须与索引时一致 |

Chat 与 Embedding 可能来自同一网关的不同模型名；脚本与服务共用同一套变量。若某网关只提供 Chat、不提供 Embedding，索引脚本失败并提示换网关，不做假向量。

### 离线索引 `scripts/embed-catalog.js`

仅处理 `status === 'published'` 且存在转写或摘要的片子。

每条视频写入两类向量：

1. **video**：文本 = `searchAbstract`（非空）否则 `title + intro + transcript` 截断（上限约 8k 字符，避免超 embedding 限额）
2. **segment**：每个 `transcriptSegments[]` 一条，文本 = 切片 `text`，附带 `startSec` / `endSec`

索引文件形状：

```json
{
  "model": "…",
  "updatedAt": 0,
  "videos": [{ "_id", "text", "vector": [0.1] }],
  "segments": [{ "_id", "videoId", "startSec", "endSec", "text", "vector": [0.1] }]
}
```

转写变更后需重跑脚本。不在保存视频时自动 embedding（本机先行、避免运营编辑卡住）。

### 在线流水线 `POST /api/ai-search`

请求：`{ query, brandId? }`  
响应：`{ ok, answer, videos: [{ _id, title, brandName, posterUrl, startSec, excerpt, reason }] }`

步骤：

1. 校验 query 非空；未开索引或未配密钥 → `ok: false` + 明确 `code`
2. Chat：把问句改写成「检索短句 + 2～5 个关键词」，JSON 输出；失败则用原 query 继续（改写失败不算整次失败）
3. Embed 改写短句（失败则整次失败）
4. 对 video 向量、segment 向量分别余弦相似度，过滤 `brandId`，各取 Top-K（K=8）
5. 按 `videoId` 合并：片子分 = `0.6 * videoScore + 0.4 * bestSegmentScore`（无切片则只用 video 分）
6. 取 Top-5 片子；Chat 只看见这些片子的 title/intro/命中切片，输出 JSON：`answer`、每片 `reason`、选用的 `startSec`（必须来自候选切片，禁止虚构秒数）
7. 用 `catalog` 的 `publicVideo` 字段组装卡片，摘录取命中切片 `text` 截断；不下发全文转写

超时：上游合计超过 20s 则失败。不回退关键词搜。

### 小程序

- `utils/api.js` 增加 `aiSearch(query, brandId)` → `wx.request` 到 8787（与 `localAdmin` 同类，无需 admin token）
- 首页：`aiMode` 或独立按钮；结果数组可与关键词结果分开展示
- 播放页：`query.t` → `initial-time`

### 测试

- 纯函数：余弦相似度、分数合并、brand 过滤、禁止虚构 startSec（给定假 LLM JSON 时丢掉非法秒）
- 不强制在 CI 打真实 API；索引脚本对空 catalog / 缺密钥给出非 0 退出码

## 风险

- ASR 错词会导致召回漂移：短说明必须引用命中原文摘录，方便人工判断
- DeepSeek 等网关若无 embedding，需换同时提供 Chat+Embed 的兼容端点（如部分阿里/硅基流动模型）
- 真机预览仍无法访问电脑的 127.0.0.1，与本地片源相同限制
