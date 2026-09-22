# 客服人工工单（先规则、后模型）

日期：2026-09-20  
载体：现有微信小程序（`miniprogram/` + 云开发）  
分支：`dev-cs-agent`（从 `main` 迁出）  
范围：底栏客服 tab 持久化会话、转人工、运营工作台回复/关闭、双方订阅消息。本期不接模型、不跳转微信原生客服。

## 背景

现网客服在 `pages/contact/contact`：快捷 FAQ 本地回复；用户打字和「没有我要的讲解 / 转人工」写入 `support_messages`。运营工作台「客服留言」只能列表、标已读，不能回复。C 端对话在页面内存里，刷新即丢。

商城总规格（`2026-09-09-survey-instrument-ai-native-mall-design.md`）里客服终态是 pi-agent-core 的 `cs` profile + 工单状态机。官方小程序客服消息（`open-type="contact"`）能接自动回复，但会话不在本 tab、卡片和时间线无法与后续 Agent/工单共用，因此不作为主通道。

本期先把「一人一条线程、运营能回、订阅能提醒」落地，集合和状态按终态预留；规则回复占住 `assistant` 位，下期再换成模型。

对话中已确认：

- 本期加强现网客服，AI 下一期。
- 不跳转官方客服会话；运营在本小程序工作台回复。
- 订阅：运营「新工单」、用户「客服已回复」；模板未配或用户拒绝时数据路径仍成功。
- 一人一条长期会话：欢迎语、快捷问答、打字、运营回复同一时间线。
- 数据用新集合 `cs_threads` / `cs_messages`，旧 `support_messages` 只读归档。

## 目标

- 用户在客服 tab 能看到跨会话的完整历史；领取账号刷新后仍可复制。
- 白名单 FAQ 不进待处理；自由打字、转人工、「没有我要的讲解」进入 `waiting_human`。
- 运营可按待处理 / 处理中 / 已关闭查看线程、回复、关闭。
- 订阅失败不回滚工单。

## 非目标

- `@earendil-works/pi-agent-core`、`agent` 云函数、`cs` profile
- `button open-type="contact"`、`wx.openCustomerServiceChat`、网页客服工具作为主通道
- 多客服抢单、质检、独立 Web 后台
- 播放页文档问答写入客服线程
- 强制把历史 `support_messages` 迁进时间线
- 长连接 / 实时推送（仅 `onShow` 拉取 + 订阅消息）

## 状态机

同一 `openid` 最多一条未关闭线程。状态：

| 状态 | 含义 | 进运营「待处理」 |
| --- | --- | --- |
| `open` | 规则客服（欢迎语、领取账号、怎么找视频） | 否 |
| `waiting_human` | 已转交，等运营首条回复 | 是 |
| `human` | 运营已回复，处理中 | 否（在「处理中」） |
| `closed` | 已关闭，只读 | 在「已关闭」 |

转移（独立纯函数，禁止散落 if）：

- `onEscalate`：`open` → `waiting_human`；已是 `waiting_human` / `human` → 保持（系统「已转交」只写一次）；`closed` → `INVALID_STATE`
- `onOperatorFirstReply`：`waiting_human` → `human`；已是 `human` → 保持；其它 → `INVALID_STATE`
- `onClose`：`waiting_human` | `human` → `closed`；其它 → `INVALID_STATE`
- `canAutoRuleReply(status)`：仅 `open` 为 true（以后 `canRunAgent` 接在同一位置，仅原 `open`/`ai` 可跑模型）

关闭后用户再 `csSend`：创建新 `open` 线程，旧线程不改。

## 数据

`catalog.initDb` / `ensureCollections` 幂等增加：

- `cs_threads`：`openid`，`status`，`createdAt`，`updatedAt`
- `cs_messages`：`threadId`，`role`（`user` | `assistant` | `operator` | `system`），`text`，`meta`（可选），`createdAt`
- `admin_notify_subscribers`：`openid`，`createdAt`

`meta` 约定：

- 规则回复：`source: "rule"`；领取账号可带 `account`
- 以后模型：`source: "model"`
- 系统转交：可空或 `event: "escalated"`

消息长度：用户/运营正文 trim 后非空，最长 500 字（与现网 `submitSupport` 一致）。

权限：仅云函数读写。C 端只通过 `cs` 云函数；用户只能读写自己 `openid` 的未关闭或历史线程。

旧集合 `support_messages` 停止由 C 端写入。`catalog.submitSupport` 可保留但小程序不再调用。工单详情可附「历史留言」只读列表（按 openid 查旧表），不做强制合并。

## 云函数 `cs`

与 `catalog` 拆开，避免工单逻辑继续堆进目录函数。用户调用不带 ticket；运营调用带现网 `ADMIN_PIN` 票据（校验方式与 `catalog` 的 `requireAdmin` 同源，抽到可复用模块，禁止复制一套口令校验）。

用户：

| action | 行为 |
| --- | --- |
| `csHistory` | 若无未关闭线程：创建 `open` 线程并写入一条欢迎 `assistant`（含快捷项对应的 `meta.actions`），再返回该线程与消息。已有未关闭线程则只读返回。欢迎语只在创建线程时写一次。 |
| `csSend` | 见下方发送规则 |
| `csEscalate` | 转人工按钮；幂等 |

运营：

| action | 行为 |
| --- | --- |
| `csAdminList` | `status` 筛选，默认 `waiting_human`，按 `updatedAt` 倒序 |
| `csAdminGet` | 线程 + 消息；校验 ticket |
| `csAdminReply` | 内容安全 → `onOperatorFirstReply` → 写 `operator` 消息 → 尝试 `CS_REPLIED` |
| `csAdminClose` | `onClose` |
| `csRegisterNotify` | 登录工作台同意订阅后写入 `admin_notify_subscribers` |

发送规则（`csSend`）：

1. 无未关闭线程：先按 `csHistory` 同样规则建线程（防止用户未拉历史就发送）。
2. 写入 `user` 消息（先 `checkText`）。
3. 若 `canAutoRuleReply` 且命中白名单（领取账号、怎么找视频）：写 `assistant`（`meta.source=rule`），状态仍为 `open`。
4. 否则（自由输入、或已非 `open`）：`onEscalate`，写 `system` 转交句（若该线程尚未写过 escalate 系统句），状态 `waiting_human`；**不再**写规则回复。
5. 转交成功后尝试给所有 `admin_notify_subscribers` 发 `CS_NEW_TICKET`。

白名单与现网 `contact.js` 的 `matchFaq` 对齐：领取账号、怎么找视频保持 `open`；「没有我要的讲解」与「转人工」、自由打字走 escalate。

并发：以线程文档条件更新（期望当前 `status`）为互斥；失败则重读再应用纯函数，避免转人工后再插入规则回复、或两条转交系统句。

## C 端

页面仍为 `pages/contact/contact`（客服 tab）。

- `onShow` 调 `csHistory`（服务端负责首次建线程和欢迎语）。页面只渲染返回的消息，不在本地再插欢迎语。快捷操作由欢迎消息的 `meta.actions` 渲染。
- 常驻「转人工」。不提供打开微信原生客服的按钮。
- `config.js` 的 `wechatId` / `phone` 可出现在转交后的系统句或附属操作里，作为补充，不是主通道。
- `waiting_human` / `human`：输入框可发，只 `csSend` 落 `user`，无自动答。
- `closed`：只读；再发送走新 `open` 线程。
- 领取账号：设备 `wx.storage` 键仍用现网 `hqh_support_account`，并写入对应消息 `meta.account`。
- 用户在转人工或自由输入的当次点击/发送里 `requestSubscribeMessage`（`CS_REPLIED`）。拒绝不影响 `csSend`。

## 运营端

`pages/admin/inbox` 从「客服留言」改为工单列表：待处理 / 处理中 / 已关闭。纯 `open` 线程不出现在待处理。点进详情为完整时间线（含转人工前 FAQ），底部回复、关闭。

登录成功后 `requestSubscribeMessage`（`CS_NEW_TICKET`）并 `csRegisterNotify`。点订阅卡片：运营进对应工单详情；用户进客服 tab。

## 订阅消息

模板 ID 放云函数环境变量（如 `CS_NEW_TICKET_TPL`、`CS_REPLIED_TPL`），不入库、不进 git。未配置则跳过 `subscribeMessage.send`。发送失败只记日志，已写入的线程和消息保留。

## 错误

- 空文本 / 超长：`BAD_INPUT`，不写库。
- 内容安全不通过：不入库，返回可理解错误。本地开发可 `SKIP_CONTENT_CHECK`，正式环境不可。
- 运营无票据或失效：`UNAUTHORIZED`，前端回登录页。
- 用户传入他人 `threadId`：拒绝。
- 对 `closed` 回复或非法转移：`INVALID_STATE`。
- 集合未建：`initDb` 幂等创建；请求失败可重试，不写半条消息。

## 与后续 AI 的接缝

不改集合、C 端时间线、运营列表。下期：`open` 改名为 `ai`（或保持 `open` 作为可跑模型状态）；`csSend` 在 `canAutoRuleReply` 为 true 且非白名单时改调 `cs` profile，不再 escalate；白名单仍可走规则。转人工后继续禁止模型循环。播放页会话仍隔离。

本期实现计划索引里的 `2026-09-09-06-cs-agent-human.md` 不在本分支执行；本规格是它的前置（人工通道 + 数据面）。

## 验收

手测：

- 首次进入有欢迎语和快捷项；杀进程再进欢迎语只有一条；领取账号仍能复制。
- 领取账号、怎么找视频不出现在待处理。
- 自由打字或转人工出现在待处理；运营回复后用户再进客服 tab 可见；关闭后再发为新线程。
- 无「打开微信客服会话」。
- 模板已配且双方同意订阅：转人工运营能收到，回复用户能收到。拒绝或未配模板：工单与回复仍成功。
- 内容安全未通过的句子不入库。运营票据失效回登录。

自动化（`node --test`，不依赖微信）：

- 状态机上表与 `closed` 不可 escalate/回复；`waiting_human` 再转人工保持；`open` 白名单不改状态。
- `csSend` 替身：白名单只写 `assistant`；自由输入 escalate 且之后无规则回复；订阅失败时 reply 仍 `ok`。
- ensure 集合名单含 `cs_threads`、`cs_messages`、`admin_notify_subscribers`。
