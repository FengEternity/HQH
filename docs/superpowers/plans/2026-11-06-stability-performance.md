# 已上线路径稳定性与性能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不增加用户能看到的新入口的前提下，让播放页提问不再卡死、少打一轮模型，并让 AI 搜索一次云函数返回。

**状态:** 已在分支 `dev-stability-perf` 实现。该分支从 `main` 迁出，因为本地 `dev` 比已上线代码少 33 个提交。尚未提交。

**Architecture:** 四条路径各自从 `dev` 迁出短分支，合回 `dev` 后再做下一条。问答仍只看当前已发布讲解；搜索仍不跑 Agent 循环；商品卡片仍只放行本轮材料里出现过的 id。观测上报最多占用 300 毫秒，不占用户等待。

**Tech Stack:** 微信云函数 `agent`、`search`、`catalog`，小程序页面，云托管 `video-ingest`。测试用现有 `node:test`。不新增 npm 依赖。

## Global Constraints

- 用户能感知的功能停在已上线的讲解、播放、播放页问答、关键词搜索、语义搜索、人工客服。
- 不实现 `video_search` / `find_videos`。不把 `customer_service` 模型接进客服自动回复。
- 播放页只回答当前 `status=published` 的讲解及其关联上架商品。
- 搜索框不进入 Agent 循环。关键词按钮仍只调 `search` 的关键词召回。
- 问答输入最长 500 字。同一视频同一用户 60 秒内最多 6 次新提问。
- 模型与工具共享 20 秒预算（`TURN_BUDGET_MS = 20000`）。单工具 5 秒。工具最多 5 次。`agent` 与 `search` 云函数时限 60 秒。
- 问答和简介仍走云开发资源点。查询向量仍用 `kinfra-text-embedding-0.6b`，维度 1024，直连 TokenHub。查询嵌入超时 12 秒。
- 语义检索已上架超过 500 条时关闭，并给出 `semantic_unavailable`。这个上限本方案不改。
- 模型 429 / 5xx 只在同一次 deadline 内重试，不自动换模型。
- 历史对话不整段塞回 prompt。
- 对外说明用简体中文。不写本地文档编号。密钥不进仓库。
- 每条路径从 `dev` 迁出下面写明的短分支，验收后合回 `dev`。不在 `main` 上开发。

四条路径可以独立上线。建议顺序：问答 → 搜索 → 入库与简介 → 首页、播放和客服。前两条都改用户等待，先做问答，因为它会把一条视频的提问锁死。

---

### Task 1: 问答回合过期

**分支:** `dev-ask-stability`

**Files:**
- Modify: `cloudfunctions/agent/lib/videoDocAction.js`
- Test: `cloudfunctions/agent/lib/videoDocAction.test.js`

**Interfaces:**
- Produces: `RUN_LEASE_MS = 55000`。`agent_runs.status === 'running'` 且 `now - updatedAt >= RUN_LEASE_MS` 时，视为该回合已失败，不返回 `IN_PROGRESS`。
- Consumes: 现有 `findRun`、`listRuns`、`updateRun`。失败后的 `resumeCount` 规则不变：同一 `requestId` 失败后还能再跑一次。

- [ ] 补测试：`updatedAt` 早于 55 秒的 `running` 不挡新的发送；未过期的 `running` 仍返回 `IN_PROGRESS`。
- [ ] 运行 `node --test cloudfunctions/agent/lib/videoDocAction.test.js`，先看新测试失败，再改判定。
- [ ] 过期时把那条 run 更新为 `failed` / `TIMEOUT`，然后按现有失败重试规则继续。租约内不启动第二轮模型。

**验收:** 云函数在写成 `running` 之后被掐断，55 秒后同一条讲解可以重新提问。55 秒内重复点击仍提示正在回答。

### Task 2: 口播按播放位置裁剪

**分支:** `dev-ask-stability`

**Files:**
- Modify: `cloudfunctions/agent/lib/videoDocTurn.js`
- Test: `cloudfunctions/agent/lib/videoDocTurn.test.js`

**Interfaces:**
- Produces: `projectVideo` 写入的 `transcript` 最长 2000 字。有 `transcriptSegments`（含 `startSec`、`endSec`、`text`）且传入 `currentTimeSec` 时，只拼接与 `[currentTimeSec - 30, currentTimeSec + 90]` 相交的段，拼完仍不超过 2000 字。没有分段时取口播开头 2000 字。发生截断时增加 `transcriptTruncated: true`。
- Consumes: `videoDocPorts` 已经返回的 `transcript` 与 `transcriptSegments`。工具 `lookup_current_video_doc` 返回这份裁剪后的投影，不返回库里的全文。

- [ ] 补测试：无分段的长口播被截到 2000 字并带 `transcriptTruncated`。播放到第 120 秒时不包含第 0–10 秒的段，包含覆盖第 120 秒的段。
- [ ] 运行 `node --test cloudfunctions/agent/lib/videoDocTurn.test.js`。

**验收:** 单次提问送进模型的口播不超过 2000 字。商品 id、标题、简介、品牌、型号仍在投影里。

### Task 3: 提问默认一次模型来回

**分支:** `dev-ask-stability`

**Files:**
- Modify: `cloudfunctions/agent/lib/videoDocModel.js`
- Test: `cloudfunctions/agent/lib/videoDocModel.test.js`（没有则按同目录现有测试风格新建）

**Interfaces:**
- Consumes: Task 2 的裁剪投影。
- Produces: `runConfiguredTurn` 首轮 `tool_choice` 为 `'auto'`。用户消息包含问题、播放位置，以及投影里的标题、简介、品牌、型号、标签、裁剪口播、上架商品。模型直接返回正文时，把本次注入的上架商品记成一条虚拟工具结果，字段仍是 `{ name: 'lookup_current_video_doc', resultCode: 'ok', cards }`。`allowedCards` 因此只放行这些商品 id。模型若真的调用工具，仍走现有 5 次上限和 5 秒单工具超时。

- [ ] 用替身 `client.chat` 证明：投影里已有口播时，一次 `chat` 返回正文即可成功，且卡片 id 只能来自投影中的商品。
- [ ] 再证明模型主动调用工具时，第二次 `chat` 仍能完成，第 6 次工具调用返回 `TIMEOUT`。
- [ ] 运行对应 `node --test`。

**验收:** 替身测试里的常见提问只有一次 `chat`。未见过的商品 id 仍被丢掉。20 秒总预算不放宽。

### Task 4: 观测上报最多等 300 毫秒

**分支:** `dev-ask-stability`

**Files:**
- Modify: `cloudfunctions/agent/lib/videoDocAction.js`
- Test: `cloudfunctions/agent/lib/videoDocAction.test.js`

**Interfaces:**
- Produces: `exportBestEffort` 对 `exportTrace` 使用 `Promise.race`，上限 `TRACE_WAIT_MS = 300`。超时或抛错都返回已写好的助手消息。成功路径和失败路径都走这个上限。

- [ ] 补测试：`exportTrace` 挂起超过 300 毫秒时，`videoDocSend` 仍返回 `ok: true` 和助手正文。
- [ ] 运行 `node --test cloudfunctions/agent/lib/videoDocAction.test.js`。

**验收:** Forseti 冷启动不再把播放页问答拖过模型本身的耗时。上报失败只记日志。

### Task 5: 客户端超时后用原请求号再取一次

**分支:** `dev-ask-stability`

**Files:**
- Modify: `miniprogram/pages/player/player.js`
- Test: `miniprogram/pages/player/player.test.js`

**Interfaces:**
- Consumes: 现有 `requestId`。同一次发送重试必须复用它。
- Produces: `videoDocSend` 因云函数超时失败时，用同一个 `requestId` 再调一次。第二次得到 `replayed` 或 `succeeded` 时展示消息。得到 `IN_PROGRESS` 时保留用户气泡和「正在回答」，不把已发送的问题清掉。其他错误仍显示原来的失败文案。

- [ ] 补测试：第一次超时、第二次 `replayed` 时消息留下来。两次都失败时恢复输入框里的原文。
- [ ] 运行 `node --test miniprogram/pages/player/player.test.js`。

**验收:** 服务端已经写好回答、客户端先超时的情况下，用户能看到该回答，不会再生成一条新的模型请求。

### Task 6: AI 搜索一次返回两栏

**分支:** `dev-search-once`

**Files:**
- Modify: `cloudfunctions/search/lib/searchIndex.js`
- Modify: `cloudfunctions/search/index.js`
- Modify: `miniprogram/pages/index/index.js`
- Test: `cloudfunctions/search/lib/searchIndex.test.js`
- Test: `miniprogram/pages/index/index.test.js`

**Interfaces:**
- Produces: `mode=ai` 的成功结果在现有 `items`、`notice` 之外增加 `keywordItems` 与 `semanticOnlyItems`。`items` 仍是关键词在前、仅语义命中在后的合并列表。`keywordItems` 只含关键词命中。`semanticOnlyItems` 是合并列表里去掉关键词 id 之后的部分。`mode=keyword` 的返回形状不变。
- Consumes: 讲解页 AI 模式只调用一次 `search({ scene: 'video', query, mode: 'ai' })`，用 `keywordItems` 和 `semanticOnlyItems` 画现在的两栏。缺这两个字段时按旧的合并列表显示，避免旧云函数把页面打空。

- [ ] 先改 `runSearch` 的纯函数测试，再改 `handleQuery` 与讲解页。
- [ ] 运行 `node --test cloudfunctions/search/lib/searchIndex.test.js miniprogram/pages/index/index.test.js`。

**验收:** AI 搜索的网络请求里只有一次 `search`。关键词按钮的请求次数和结果不变。低并发环境下不再为同一句查询排队两次。

### Task 7: 语义路按名次保留，查询向量当天复用

**分支:** `dev-search-once`

**Files:**
- Modify: `cloudfunctions/search/lib/vectorRank.js`
- Modify: `cloudfunctions/search/index.js`
- Modify: `cloudfunctions/search/lib/embedClient.js`（只给查询路径加缓存读写，索引嵌入不读这条缓存）
- Test: `cloudfunctions/search/lib/vectorRank.js` 旁的 `hybridSearch.test.js` 与 `vectorRank` 现有测试

**Interfaces:**
- Produces: 用户搜索调用 `selectVectorHits` 时不因 `cosine < 0.678` 丢弃命中，仍按余弦降序最多留 8 条。`0.678` 常量保留给运营探测。已上架超过 500 条时语义路仍然关闭。
- Produces: 查询向量缓存键为 `sha256(EMBEDDING_MODEL + '\n' + 归一化后的查询句)`。集合 `search_query_cache` 存 `embedding`、`embeddingModel`、`updatedAt`。24 小时内命中则不再请求 TokenHub。缓存读写失败时照常嵌入，搜索不因此失败。
- Consumes: `loadChunks` 的每 10 条查询改为 `Promise.all` 并行，结果顺序不参与排名。

- [ ] 补测试：余弦 0.2 的唯一近邻出现在语义命中里。同一查询句第二次不调用嵌入函数。缓存维度不对时回源嵌入。
- [ ] 运行 `node --test cloudfunctions/search/lib/hybridSearch.test.js cloudfunctions/search/lib/searchIndex.test.js`。

**验收:** 语义结果不再因为门槛被滤成空列表。相同短句在一天内只嵌入一次。片库超过 500 条时的提示文案不变。

### Task 8: 简介只吃截断口播，长片处理续租

**分支:** `dev-ingest-lease`

**Files:**
- Modify: `cloudfunctions/agent/lib/writeVideoIntro.js`
- Modify: `scripts/video-ingest/lib/requestIntro.js`
- Modify: `cloudfunctions/catalog/lib/videoIngest.js`
- Modify: `scripts/video-ingest/worker.js`
- Test: `cloudfunctions/agent/lib/writeVideoIntro.test.js`
- Test: `cloudfunctions/catalog/lib/videoIngestJobs.test.js`

**Interfaces:**
- Produces: 送进简介模型的口播最长 4000 字，超长时保留开头并在提示中写明已截取。`boundedText` 仍拒绝非字符串；容器在调用 `agent` 前先截到 4000 字，避免把 10 万字传进云函数。简介正文要求仍是约 100 字，`max_tokens` 仍是 256，超时仍是 20 秒。
- Produces: 处理中的任务每 60 秒把 `claimedAt` 更新为当前时间。`CLAIM_TIMEOUT_MS` 仍是 30 分钟，只用于心跳中断后的重抢。下载、转码、识别期间心跳保持这条任务不被第二份进程领取。

- [ ] 简介测试断言用户提示里的口播不超过 4000 字。
- [ ] 续租测试断言心跳后的 `claimedAt` 落在租约窗口内，另一 worker 领不到它。心跳停止满 30 分钟后可以重抢。
- [ ] 上架时已有的单条 `reindexVideo` 保持不动。不把嵌入批大小从 1 改大。

**验收:** 长口播仍能生成简介或明确失败，不会先把云函数撑满。一条正在转码的长片不会被第二个 worker 重抢。

### Task 9: 首页、播放地址和客服轮询

**分支:** `dev-client-steady`

**Files:**
- Modify: `miniprogram/pages/index/index.js`
- Modify: `miniprogram/pages/player/player.js`
- Modify: `miniprogram/pages/contact/contact.js`
- Test: `miniprogram/pages/index/index.test.js`
- Test: `miniprogram/pages/player/player.test.js`
- Test: `miniprogram/pages/contact/contact.test.js`

**Interfaces:**
- Produces: 讲解页 `onShow` 在 60 秒内复用上一次成功的 `listHome`，不重复打云函数。超过 60 秒或上次失败才再请求。下拉或现有重试按钮立即请求。
- Produces: 播放器 `onVideoError` 对当前 `videoId` 再调一次 `getVideo`。第二次仍无地址时才留下「视频无法播放」。
- Produces: 客服页可见时的轮询从 4 秒开始，没有新消息就加倍，上限 30 秒。发送、收到新消息或重新 `onShow` 时回到 4 秒。

- [ ] 分别为三段行为补页面测试，并运行对应的 `node --test`。

**验收:** 来回切换讲解 tab 不会每秒打 `listHome`。临时链失效后会自动再取一次。客服页停在前台时，空会话不会一直每 4 秒拉全量历史。

---

## 本方案不做

- 不把向量检索从云函数文档库迁到常驻检索引擎。Task 7 只做并行读和查询缓存。片库接近 500 条时再单独立项。
- 不放宽 20 秒问答预算，不提高 500 条语义上限，不自动更换失败模型。
- 不把客服历史或播放页历史整段写入模型上下文。
- 不改商城下单。商城仍不在底栏。

## 合回前的手工验收

- 播放页对一条长口播提问，真机在一次等待内看到回答；连续点两次不会卡在「正在回答」。
- 拔掉 Forseti 或让它超时，问答仍返回。
- AI 搜索只出现一次 `search` 调用，关键词栏和语义栏都还在。
- 一句低于 0.678、但向量最近的讲解能出现在语义栏。
- 一条超过 30 分钟的转码任务不会被第二份进程领走。
