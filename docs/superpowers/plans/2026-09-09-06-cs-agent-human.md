# 客服 Agent 与转人工 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 客服 tab 默认 pi-agent-core `cs` profile（全站检索 + 本人订单）；常驻转人工；转人工后不再进 Agent 循环；运营可回复；尝试发订阅消息。

**Architecture:** `agent` 增加 `profile=cs`。工具：`search`（可 `video`/`product`）、`list_my_orders`、`escalate_to_human`。工单状态机独立纯函数。`cs` 云函数或 `agent` 的 admin actions 负责运营回复。现网 `support_messages` 迁移或双写后 C 端只显示 `cs_messages`。快捷 FAQ 白名单（领取账号）可走规则，其余进 Agent。播放页会话不写入客服工单。

**Tech Stack:** 同一 `agent` 云函数、订阅消息、现有 admin ticket、`node --test`。

## Global Constraints

- 转人工后同一线程不再进入 pi-agent-core 循环。
- 禁止编造物流；订单只有三态。
- 不跳转微信原生客服。
- 未配置订阅模板时工单数据路径仍成功。
- Commit 用简体中文。
- 本计划在 **`dev-cs-agent`** 上执行（从 `dev` 迁出）；验收后合回 `dev`。

---

### Task 1: 工单状态与「禁止再跑 Agent」

**Files:**
- Create: `cloudfunctions/agent/lib/csThreadState.js`
- Create: `cloudfunctions/agent/lib/csThreadState.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `canRunAgent(status)` → 仅 `ai` 为 true
  - `onEscalate(status)` → `ai` 变为 `waiting_human`；其它抛 `INVALID_STATE`
  - `onOperatorFirstReply(status)` → `waiting_human` 变为 `human`；已是 `human` 保持
  - `onClose(status)` → `waiting_human|human` 变为 `closed`

- [ ] **Step 1: Write failing tests** 覆盖上表与 `closed` 不可 escalate

- [ ] **Step 2: Run, expect FAIL** — `node --test cloudfunctions/agent/lib/csThreadState.test.js`

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/agent/lib/csThreadState.js cloudfunctions/agent/lib/csThreadState.test.js
git commit -m "$(cat <<'EOF'
feat(agent): 客服线程状态与停用模型的边界

EOF
)"
```

---

### Task 2: cs 工具、客服页、运营工单、通知

**Files:**
- Create: `cloudfunctions/agent/lib/csTools.js`、`csTools.test.js` — `search` 工具必须带 `scene`；`escalate` 只改状态不调模型
- Modify: `agent/index.js` — `csSend`：若 `!canRunAgent` 只落用户消息；`csEscalate`；`csHistory`
- Modify: `ensureCollections` — `cs_threads`、`cs_messages`、`admin_notify_subscribers`
- Modify: `miniprogram/pages/contact/*` — 默认对话走 `csSend`；常驻按钮「转人工」；去掉「去客服」类跳转（已在 tab）
- Modify: `miniprogram/pages/admin/inbox/*` 或新 `admin/tickets` — 待处理优先、回复、关闭
- Modify: admin 登录成功后 `wx.requestSubscribeMessage` 并 `registerAdminNotify`
- Modify: `README.md` 订阅消息模板 `CS_NEW_TICKET`、`CS_REPLIED`

**Interfaces:**
- Consumes: `canRunAgent`、`onEscalate`、`runSearch` 或 HTTP 调 search 云函数、`listMyOrders` 读 `orders`
- Produces: 运营回复写入 `role=operator`；用户侧可见；尝试订阅消息失败不回滚工单

- [ ] **Step 1: csTools 单测** — search 被调用时 scene 为 video 或 product；escalate 测试替身 `runAgent` 调用次数为 0

- [ ] **Step 2: contact 页接 csSend；waiting_human 时输入仍发送但不出现新的 assistant 模型气泡（可有系统「已转交」）**

- [ ] **Step 3: 手测转人工、运营回复、未授权订阅仍能回**

Run: `node --test cloudfunctions/agent/lib/csThreadState.test.js cloudfunctions/agent/lib/csTools.test.js cloudfunctions/agent/lib/videoDocTools.test.js`

- [ ] **Step 4: Commit**

```bash
git add cloudfunctions/agent cloudfunctions/catalog/lib/ensureCollections.js cloudfunctions/catalog/lib/ensureCollections.test.js miniprogram/pages/contact miniprogram/pages/admin README.md
git commit -m "$(cat <<'EOF'
feat(agent): 客服默认 AI 并支持转人工工单

EOF
)"
```
