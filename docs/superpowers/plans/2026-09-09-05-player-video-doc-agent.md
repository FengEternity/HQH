# 播放页文档问答（pi-agent-core） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 播放页视频下方可针对**当前视频**提问；运行时为 `@earendil-works/pi-agent-core`；不跳转客服、无转人工；工具不得全库搜其它视频。

**Architecture:** 云函数 `agent` 内 `profile=video_doc`。工具 `lookup_current_video_doc` 只读传入的 `videoId` 文档字段 + 该视频关联上架商品。会话键 `openid + videoId`（未登录用云开发匿名 openid）。小程序只渲染消息，不跑 Agent 循环。不安装 `pi-coding-agent`，不注册 filesystem/shell 工具。

**Tech Stack:** `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、云函数 Node、`node --test`。

## Global Constraints

- 播放页对话与客服 tab 会话不合并。
- `video_doc` 无订单工具、无转人工工具。
- 单轮工具调用上限 ≤5；超时可重试，会话已落库。
- 模型密钥只放云函数环境变量。
- 第一期不按播放进度自动切章节。
- Commit 用简体中文。

---

### Task 1: video_doc 工具边界单测（不连模型）

**Files:**
- Create: `cloudfunctions/agent/lib/videoDocTools.js`
- Create: `cloudfunctions/agent/lib/videoDocTools.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `createVideoDocTools({ videoId, loadVideo, loadLinkedProducts })` 返回工具定义数组；执行 `lookup_current_video_doc` 时若内部去加载**另一个** id，测试用的 fake `loadVideo` 会记录 id，断言只出现当前 `videoId`。商品仅来自 `loadLinkedProducts(videoId)`。

- [ ] **Step 1: Write failing test**

fake `loadVideo` 若收到非 `vid-1` 则 `assert.fail`。调用工具一次，传入 `videoId: 'vid-1'`。

再测：`loadLinkedProducts` 返回 unpublished 时，工具结果里过滤掉。

- [ ] **Step 2: Run, expect FAIL**

Run: `node --test cloudfunctions/agent/lib/videoDocTools.test.js`

- [ ] **Step 3: Implement tool**

返回结构含 `title`、`intro`、`tags`、`brandName`、`modelName`、可选 transcript 字段、`products: [{ id, name, priceFen }]` 仅 published。

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/agent/lib/videoDocTools.js cloudfunctions/agent/lib/videoDocTools.test.js
git commit -m "$(cat <<'EOF'
feat(agent): 播放页问答工具只读取当前视频文档

EOF
)"
```

---

### Task 2: agent 云函数与播放页 UI

**Files:**
- Create: `cloudfunctions/agent/package.json`（依赖 `wx-server-sdk`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`）、`index.js`、`config.json`
- Create: `cloudfunctions/agent/lib/runVideoDocTurn.js` — 组装 Agent、system prompt（只答本条讲解）、把用户消息跑一轮
- Create: `cloudfunctions/agent/lib/runVideoDocTurn.test.js` — 注入假 Agent：断言 `profile` 校验、缺 `videoId` 抛 `BAD_INPUT`；假循环被调用一次
- Modify: `ensureCollections` 追加 `video_doc_threads`、`video_doc_messages`
- Modify: `miniprogram/utils/api.js` — `agentFn`
- Modify: `miniprogram/pages/player/player.wxml` — 关联商品下方对话区（消息列表、输入、发送）；无「去客服问」
- Modify: `player.js` — `listMessages` + `send`；可选把 `currentTime` 当上下文字段，不 seek
- Modify: `README.md`：部署 `agent`；环境变量模型密钥

**Interfaces:**
- Consumes: `createVideoDocTools`、pi-agent-core `Agent`
- Produces: actions `videoDocHistory({ videoId })`、`videoDocSend({ videoId, text, currentTimeSec? })` → `{ messages }`

System prompt 必须写明：不得假装全站客服；其它型号请用户回讲解搜索。

- [ ] **Step 1: 校验与假循环单测 PASS**

- [ ] **Step 2: 真 Agent 接入 index.js**（密钥缺失时返回明确错误，不要空回复）

- [ ] **Step 3: 播放页 UI 与手测**

问当前简介能答；问完全无关型号应拒绝扩范围。确认没有跳转客服按钮。

- [ ] **Step 4: Commit**

```bash
git add cloudfunctions/agent cloudfunctions/catalog/lib/ensureCollections.js cloudfunctions/catalog/lib/ensureCollections.test.js miniprogram/pages/player miniprogram/utils/api.js README.md
git commit -m "$(cat <<'EOF'
feat(agent): 播放页用 pi-agent-core 做本条讲解问答

EOF
)"
```
