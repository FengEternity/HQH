# 客服人工工单 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 客服 tab 一人一条可持久化规则会话；白名单 FAQ 不进待处理；打字/转人工进工单；运营在工作台回复与关闭；双方订阅失败不丢数据。

**Architecture:** 工单状态与发送决策做成纯函数。新云函数 `cs` 读写 `cs_threads` / `cs_messages` / `admin_notify_subscribers`。运营票据复用 `catalog` 同款 HMAC（把 `ticket.js` 原文拷进 `cs`，与 `shop` 一样，不要另写一套算法）。C 端只渲染服务端历史；`catalog.initDb` 幂等建集合。本期不接 pi-agent-core、不调用 `open-type="contact"`。

**Tech Stack:** 微信云开发 `wx-server-sdk`、云数据库、订阅消息、原生小程序页、`node --test`。

## Global Constraints

- 规格：`docs/superpowers/specs/2026-09-20-cs-human-inbox-design.md`。
- 不跳转微信原生客服，不新增 `open-type="contact"`。
- 模板环境变量未配置或 `subscribeMessage.send` 失败时，线程与消息仍成功。
- 用户/运营正文 trim 后非空，最长 500 字。
- 内容安全与 `catalog` 相同：`SKIP_CONTENT_CHECK=1` 仅本地；正式环境不可。
- 领取账号存储键仍为 `hqh_support_account`。
- C 端不再调用 `catalog.submitSupport`。
- Commit message 用简体中文，不要写 `DES-*` / `ANAL-*`。
- 在 **`dev-cs-agent`** 上执行，不要在 `main` 上开发。

## 文件地图

| 路径 | 职责 |
| --- | --- |
| `cloudfunctions/cs/lib/csThreadState.js` | 状态转移纯函数 |
| `cloudfunctions/cs/lib/csFaq.js` | 白名单 vs 转人工分类 |
| `cloudfunctions/cs/lib/contactCopy.js` | 欢迎语、规则答、转交句（与 `miniprogram/config.js` 的 `contact` 对齐） |
| `cloudfunctions/cs/lib/csSendFlow.js` | 根据状态+分类决定追加哪些消息、下一状态、是否通知运营 |
| `cloudfunctions/cs/lib/notify.js` | 订阅发送：无模板则跳过，抛错则吞掉 |
| `cloudfunctions/cs/lib/ticket.js` | 与 `cloudfunctions/catalog/lib/ticket.js` 逐字相同 |
| `cloudfunctions/cs/lib/csStore.js` | 找未关闭线程、条件更新、写消息（可测假 db） |
| `cloudfunctions/cs/index.js` | action 分发、内容安全、OPENID、运营 ticket |
| `cloudfunctions/catalog/lib/ensureCollections.js` | `initDb` 增加三集合 |
| `miniprogram/utils/api.js` | `cs()` 调用封装 |
| `miniprogram/pages/contact/*` | 拉历史、发送、转人工、订阅用户模板 |
| `miniprogram/pages/admin/inbox/*` | 工单列表 |
| `miniprogram/pages/admin/ticket/*` | 工单详情回复关闭 |
| `miniprogram/pages/admin/login/login.js` | 登录成功后订新工单并 `csRegisterNotify` |
| `README.md` | 集合、云函数 `cs`、订阅环境变量、手测 |

---

### Task 1: 工单状态纯函数

**Files:**
- Create: `cloudfunctions/cs/lib/csThreadState.js`
- Create: `cloudfunctions/cs/lib/csThreadState.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `STATUSES` = `['open', 'waiting_human', 'human', 'closed']`
  - `canAutoRuleReply(status)` → 仅 `'open'` 为 `true`
  - `onEscalate(status)` → `'open'` 得 `'waiting_human'`；`'waiting_human'` / `'human'` 原样返回；`'closed'` 及其它抛 `Error` 且 `code === 'INVALID_STATE'`
  - `onOperatorFirstReply(status)` → `'waiting_human'` 得 `'human'`；已是 `'human'` 保持；其它抛 `INVALID_STATE`
  - `onClose(status)` → `'waiting_human'` | `'human'` 得 `'closed'`；其它抛 `INVALID_STATE`

- [ ] **Step 1: Write the failing test**

```js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  canAutoRuleReply,
  onEscalate,
  onOperatorFirstReply,
  onClose,
} = require('./csThreadState');

function codeOf(fn) {
  try {
    fn();
    return '';
  } catch (err) {
    return err.code;
  }
}

describe('csThreadState', () => {
  it('canAutoRuleReply only for open', () => {
    assert.equal(canAutoRuleReply('open'), true);
    assert.equal(canAutoRuleReply('waiting_human'), false);
    assert.equal(canAutoRuleReply('human'), false);
    assert.equal(canAutoRuleReply('closed'), false);
  });

  it('onEscalate open to waiting_human and is idempotent for waiting_human and human', () => {
    assert.equal(onEscalate('open'), 'waiting_human');
    assert.equal(onEscalate('waiting_human'), 'waiting_human');
    assert.equal(onEscalate('human'), 'human');
    assert.equal(codeOf(() => onEscalate('closed')), 'INVALID_STATE');
  });

  it('onOperatorFirstReply and onClose follow the table', () => {
    assert.equal(onOperatorFirstReply('waiting_human'), 'human');
    assert.equal(onOperatorFirstReply('human'), 'human');
    assert.equal(codeOf(() => onOperatorFirstReply('open')), 'INVALID_STATE');
    assert.equal(onClose('waiting_human'), 'closed');
    assert.equal(onClose('human'), 'closed');
    assert.equal(codeOf(() => onClose('open')), 'INVALID_STATE');
    assert.equal(codeOf(() => onClose('closed')), 'INVALID_STATE');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test cloudfunctions/cs/lib/csThreadState.test.js`

Expected: FAIL，模块不存在。

- [ ] **Step 3: Write minimal implementation**

```js
'use strict';

function invalid(status) {
  const err = new Error('INVALID_STATE');
  err.code = 'INVALID_STATE';
  err.status = status;
  throw err;
}

function canAutoRuleReply(status) {
  return status === 'open';
}

function onEscalate(status) {
  if (status === 'open') {
    return 'waiting_human';
  }
  if (status === 'waiting_human' || status === 'human') {
    return status;
  }
  invalid(status);
}

function onOperatorFirstReply(status) {
  if (status === 'waiting_human') {
    return 'human';
  }
  if (status === 'human') {
    return 'human';
  }
  invalid(status);
}

function onClose(status) {
  if (status === 'waiting_human' || status === 'human') {
    return 'closed';
  }
  invalid(status);
}

module.exports = {
  STATUSES: ['open', 'waiting_human', 'human', 'closed'],
  canAutoRuleReply,
  onEscalate,
  onOperatorFirstReply,
  onClose,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test cloudfunctions/cs/lib/csThreadState.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/cs/lib/csThreadState.js cloudfunctions/cs/lib/csThreadState.test.js
git commit -m "$(cat <<'EOF'
feat(cs): 客服工单状态机纯函数

EOF
)"
```

---

### Task 2: FAQ 分类与发送决策

**Files:**
- Create: `cloudfunctions/cs/lib/csFaq.js`
- Create: `cloudfunctions/cs/lib/csFaq.test.js`
- Create: `cloudfunctions/cs/lib/contactCopy.js`
- Create: `cloudfunctions/cs/lib/csSendFlow.js`
- Create: `cloudfunctions/cs/lib/csSendFlow.test.js`

**Interfaces:**
- Consumes: `canAutoRuleReply`, `onEscalate` from `./csThreadState`
- Produces:
  - `MAX_TEXT_LEN` = `500`
  - `assertUserText(raw)` → trim 后的字符串；空或超长抛 `BAD_INPUT`（文案：`请输入内容` / `内容太长`）
  - `classifyTurn({ text, faqId })` → `'claim' | 'howto' | 'escalate'`。`faqId` 优先：`claim`/`howto` 原样，`missing`/`human` → `escalate`。否则按现网 `matchFaq` 顺序：账号|领取 → claim；没有|缺|找不到|完善|问题库 → escalate；怎么找|搜索|视频 → howto；人工|微信|电话|联系 → escalate；其余 escalate
  - `contactCopy` 对象：`hours`、`welcome`、`faqs`（id/title/answer 与 `miniprogram/config.js` 的 `contact` 一致）、`escalatedText` = `'已转交运营。请稍候，回复会出现在本页。'`
  - `welcomeActions` = `[{ id: 'claim', label: '领取账号' }, { id: 'missing', label: '没有我要的讲解' }, { id: 'howto', label: '怎么找视频' }]`
  - `planSend({ status, text, faqId, account, hasEscalateSystem, wechatId, phone })` → `{ nextStatus, notifyAdmins, messages }`。`messages` 为按顺序追加的消息草稿（无 `_id`）：每条含 `role`、`text`、可选 `meta`。规则：先断言文本；先追加 `user`；若 `canAutoRuleReply(status)` 且分类为 `claim`/`howto`：再追加 `assistant`（claim 的 answer 后接账号说明，`meta: { source: 'rule', account }`，howto 用 faq answer，`meta: { source: 'rule' }`），`nextStatus` 仍为 `open`，`notifyAdmins` false；否则 `nextStatus = onEscalate(status)`，若 `!hasEscalateSystem` 再追加 `system`（`escalatedText` 后按 `wechatId`/`phone` 换行附联系方式，`meta: { event: 'escalated' }`），`notifyAdmins` 为 `status === 'open'`（首次从 open 转出才通知）

- [ ] **Step 1: Write the failing tests**

`csFaq.test.js`：

```js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { classifyTurn, assertUserText } = require('./csFaq');

describe('csFaq', () => {
  it('prefers faqId and maps missing/human to escalate', () => {
    assert.equal(classifyTurn({ text: 'x', faqId: 'claim' }), 'claim');
    assert.equal(classifyTurn({ text: 'x', faqId: 'howto' }), 'howto');
    assert.equal(classifyTurn({ text: 'x', faqId: 'missing' }), 'escalate');
    assert.equal(classifyTurn({ text: 'x', faqId: 'human' }), 'escalate');
  });

  it('matches typed text like the live contact page', () => {
    assert.equal(classifyTurn({ text: '领取账号' }), 'claim');
    assert.equal(classifyTurn({ text: '怎么找视频' }), 'howto');
    assert.equal(classifyTurn({ text: '没有我要的讲解' }), 'escalate');
    assert.equal(classifyTurn({ text: '转人工' }), 'escalate');
    assert.equal(classifyTurn({ text: '全站仪测不了' }), 'escalate');
  });

  it('rejects empty and overlong text', () => {
    try {
      assertUserText('  ');
      assert.fail('expected throw');
    } catch (err) {
      assert.equal(err.code, 'BAD_INPUT');
    }
    try {
      assertUserText('汉'.repeat(501));
      assert.fail('expected throw');
    } catch (err) {
      assert.equal(err.code, 'BAD_INPUT');
    }
    assert.equal(assertUserText('  ok  '), 'ok');
  });
});
```

`csSendFlow.test.js`：

```js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { planSend } = require('./csSendFlow');

describe('planSend', () => {
  it('keeps open and replies for claim/howto without notifying admins', () => {
    const claim = planSend({
      status: 'open',
      text: '领取账号',
      faqId: 'claim',
      account: 'YD1',
      hasEscalateSystem: false,
    });
    assert.equal(claim.nextStatus, 'open');
    assert.equal(claim.notifyAdmins, false);
    assert.equal(claim.messages[0].role, 'user');
    assert.equal(claim.messages[1].role, 'assistant');
    assert.equal(claim.messages[1].meta.source, 'rule');
    assert.equal(claim.messages[1].meta.account, 'YD1');

    const howto = planSend({ status: 'open', text: '怎么找视频', faqId: 'howto', hasEscalateSystem: false });
    assert.equal(howto.nextStatus, 'open');
    assert.equal(howto.notifyAdmins, false);
    assert.equal(howto.messages[1].meta.source, 'rule');
  });

  it('escalates free text from open and writes system once', () => {
    const first = planSend({ status: 'open', text: '全站仪坏了', hasEscalateSystem: false });
    assert.equal(first.nextStatus, 'waiting_human');
    assert.equal(first.notifyAdmins, true);
    assert.equal(first.messages.some((m) => m.role === 'system'), true);
    assert.equal(first.messages.some((m) => m.role === 'assistant'), false);

    const again = planSend({ status: 'waiting_human', text: '还有一句', hasEscalateSystem: true });
    assert.equal(again.nextStatus, 'waiting_human');
    assert.equal(again.notifyAdmins, false);
    assert.equal(again.messages.length, 1);
    assert.equal(again.messages[0].role, 'user');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test cloudfunctions/cs/lib/csFaq.test.js cloudfunctions/cs/lib/csSendFlow.test.js`

Expected: FAIL，模块不存在。

- [ ] **Step 3: Implement `contactCopy.js`, `csFaq.js`, `csSendFlow.js`**

`contactCopy.js` 把 `miniprogram/config.js` 里 `contact.welcome`、`hours`、四条 `faqs` 原文拷过来。另导出：

```js
const welcomeActions = [
  { id: 'claim', label: '领取账号' },
  { id: 'missing', label: '没有我要的讲解' },
  { id: 'howto', label: '怎么找视频' },
];
const escalatedText = '已转交运营。请稍候，回复会出现在本页。';
module.exports = { hours, welcome, faqs, welcomeActions, escalatedText };
```

`csFaq.js` 实现 `MAX_TEXT_LEN`、`assertUserText`、`classifyTurn`（见 Interfaces）。

`csSendFlow.js`：

```js
'use strict';

const { canAutoRuleReply, onEscalate } = require('./csThreadState');
const { assertUserText, classifyTurn } = require('./csFaq');
const { faqs, escalatedText } = require('./contactCopy');

function faqById(id) {
  return faqs.find((item) => item.id === id);
}

function systemEscalateBody(wechatId, phone) {
  let body = escalatedText;
  if (wechatId) {
    body += '\n客服微信：' + wechatId;
  }
  if (phone) {
    body += '\n客服电话：' + phone;
  }
  return body;
}

function planSend(input) {
  const text = assertUserText(input.text);
  const kind = classifyTurn({ text, faqId: input.faqId });
  const userMsg = { role: 'user', text };
  if (canAutoRuleReply(input.status) && (kind === 'claim' || kind === 'howto')) {
    const faq = faqById(kind);
    const assistant = {
      role: 'assistant',
      text: faq.answer,
      meta: { source: 'rule' },
    };
    if (kind === 'claim') {
      assistant.meta.account = String(input.account || '');
      assistant.text =
        '这是你的资料馆账号，点复制带走。回来搜型号、补充问题时把账号一并告诉我。';
    }
    return {
      nextStatus: 'open',
      notifyAdmins: false,
      messages: [userMsg, assistant],
    };
  }
  const nextStatus = onEscalate(input.status);
  const messages = [userMsg];
  if (!input.hasEscalateSystem) {
    messages.push({
      role: 'system',
      text: systemEscalateBody(input.wechatId, input.phone),
      meta: { event: 'escalated' },
    });
  }
  return {
    nextStatus,
    notifyAdmins: input.status === 'open',
    messages,
  };
}

module.exports = { planSend, systemEscalateBody };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test cloudfunctions/cs/lib/csThreadState.test.js cloudfunctions/cs/lib/csFaq.test.js cloudfunctions/cs/lib/csSendFlow.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/cs/lib/csFaq.js cloudfunctions/cs/lib/csFaq.test.js cloudfunctions/cs/lib/contactCopy.js cloudfunctions/cs/lib/csSendFlow.js cloudfunctions/cs/lib/csSendFlow.test.js
git commit -m "$(cat <<'EOF'
feat(cs): 规则白名单与转人工发送决策

EOF
)"
```

---

### Task 3: initDb 增加客服集合

**Files:**
- Modify: `cloudfunctions/catalog/lib/ensureCollections.js`（`CATALOG_COLLECTIONS` 末尾追加 `'cs_threads'`、`'cs_messages'`、`'admin_notify_subscribers'`）
- Test: `cloudfunctions/catalog/lib/ensureCollections.test.js`（已按数组全等断言，名单一改即覆盖；再加一条 `it('includes cs collections')` 明确三个名字）

**Interfaces:**
- Consumes: 现有 `ensureCollections(db, names?)`
- Produces: 默认创建名单含上述三集合。`README` 集合说明在 Task 7 改，本任务不改 README。

- [ ] **Step 1: Write the failing assertion**

在 `ensureCollections.test.js` 的第一个 `describe` 里追加：

```js
  it('includes cs ticket collections', () => {
    assert.ok(CATALOG_COLLECTIONS.includes('cs_threads'));
    assert.ok(CATALOG_COLLECTIONS.includes('cs_messages'));
    assert.ok(CATALOG_COLLECTIONS.includes('admin_notify_subscribers'));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test cloudfunctions/catalog/lib/ensureCollections.test.js`

Expected: FAIL，`includes cs ticket collections` 断言失败。

- [ ] **Step 3: Append the three names to `CATALOG_COLLECTIONS`**

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test cloudfunctions/catalog/lib/ensureCollections.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/catalog/lib/ensureCollections.js cloudfunctions/catalog/lib/ensureCollections.test.js
git commit -m "$(cat <<'EOF'
feat(catalog): initDb 创建客服线程与订阅者集合

EOF
)"
```

---

### Task 4: 订阅发送失败不回滚

**Files:**
- Create: `cloudfunctions/cs/lib/notify.js`
- Create: `cloudfunctions/cs/lib/notify.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `notifyNewTicket({ send, templateId, tousers, page, now })` → `{ ok: true, sent, skipped }`。`templateId` 空则 `skipped = tousers.length`、不调 `send`。对每个 touser 调 `send({ touser, templateId, page, data })`；`data` 固定为 `{ thing3: { value: '待处理工单' }, time2: { value: 本地可读时间 } }`（公众平台关键词不一致时只改 `notify.js` 这一处）。单条 `send` 抛错记入 skipped，不抛给调用方。
  - `notifyReplied({ send, templateId, touser, page, now })` → 同上，无 template 或无 touser 则 skip；`data.thing3.value` 为 `'客服已回复'`。

时间格式：`YYYY-MM-DD HH:mm`（垫零），用 `now` 毫秒。

- [ ] **Step 1: Write the failing test**

```js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { notifyNewTicket, notifyReplied } = require('./notify');

describe('notify', () => {
  it('skips when template id is missing', async () => {
    let calls = 0;
    const send = async () => {
      calls += 1;
    };
    const res = await notifyNewTicket({
      send,
      templateId: '',
      tousers: ['a'],
      page: 'pages/admin/inbox/inbox',
      now: Date.parse('2026-09-20T12:00:00+08:00'),
    });
    assert.equal(calls, 0);
    assert.equal(res.ok, true);
    assert.equal(res.skipped, 1);
  });

  it('keeps ok when send throws', async () => {
    const send = async () => {
      throw new Error('quota');
    };
    const res = await notifyReplied({
      send,
      templateId: 'tpl',
      touser: 'user1',
      page: 'pages/contact/contact',
      now: 0,
    });
    assert.equal(res.ok, true);
    assert.equal(res.skipped, 1);
    assert.equal(res.sent, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test cloudfunctions/cs/lib/notify.test.js`

Expected: FAIL，模块不存在。

- [ ] **Step 3: Implement `notify.js`**

`send` 的实参必须包含 `touser`、`templateId`、`page`、`data`。捕获每条错误，`sent`/`skipped` 计数。`notifyNewTicket` 对 `tousers` 循环；`notifyReplied` 把单个 `touser` 当成长度为 0 或 1 的列表。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test cloudfunctions/cs/lib/notify.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/cs/lib/notify.js cloudfunctions/cs/lib/notify.test.js
git commit -m "$(cat <<'EOF'
feat(cs): 订阅消息缺模板或失败时不回滚

EOF
)"
```

---

### Task 5: 云函数 `cs` 存储与 action

**Files:**
- Create: `cloudfunctions/cs/package.json`（与 catalog 相同：`wx-server-sdk` `~3.0.1`）
- Create: `cloudfunctions/cs/lib/ticket.js`（从 `cloudfunctions/catalog/lib/ticket.js` 原样复制）
- Create: `cloudfunctions/cs/lib/csStore.js`
- Create: `cloudfunctions/cs/lib/csStore.test.js`
- Create: `cloudfunctions/cs/index.js`

**Interfaces:**
- Consumes: `planSend`、`onOperatorFirstReply`、`onClose`、`contactCopy`、`welcomeActions`、`notifyNewTicket`、`notifyReplied`、`verifyTicket`
- Produces:
  - `makeMemoryDb()` 仅测试用，实现 `collection(name).add/get/where/orderBy/limit/doc().get/update` 的最小子集
  - `csHistory(db, { openid, now })`：无未关闭线程则 `add` 一条 `status:'open'` 的 thread，再 `add` 一条 `assistant` 欢迎（`text` 为 `welcome`，`meta: { source: 'rule', actions: welcomeActions }`）；已有则只读。返回 `{ ok: true, thread, messages }`，messages 按 `createdAt` 升序。
  - `csSend(db, { openid, text, faqId, account, wechatId, phone, now, notifyAdminsFn })`：无未关闭线程先走 history 建线程；`hasEscalateSystem` 看已有消息是否存在 `meta.event === 'escalated'`；`planSend`；条件更新线程 `status`（`where({ _id, status: 旧 })`，`updated` 为 0 则抛 `INVALID_STATE`）；再按序 `add` 消息；若 `notifyAdmins` 则 `await notifyAdminsFn()`（测试里可扔错，send 仍须 `ok: true`）。返回 `{ ok: true, thread, messages }` 为该线程全量消息。
  - `csEscalate(db, same as send but text 默认「转人工」、faqId `'human'` )`
  - `csAdminList(db, { status, now })` 默认 `status: 'waiting_human'`，按 `updatedAt` 倒序，最多 100
  - `csAdminGet(db, { threadId })`
  - `csAdminReply(db, { threadId, text, now, notifyUserFn })`：`assertUserText`；`onOperatorFirstReply`；条件更新；写 `operator` 消息；`await notifyUserFn()` 即使抛错仍 `ok`
  - `csAdminClose(db, { threadId, now })`
  - `csRegisterNotify(db, { openid, now })`：同一 openid 已存在则不重复 add
  - `index.js` `exports.main`：与 catalog 相同的 `{ ok:false, code, message }` 包一层。`ADMIN_PIN` + `verifyTicket`。用户 action 用 `cloud.getWXContext().OPENID`。`checkText` 逻辑从 catalog 拷过来（`SKIP_CONTENT_CHECK`、`CONTENT_REJECTED`）。`notify` 的 `send` 为 `cloud.openapi.subscribeMessage.send`。模板 ID：`process.env.CS_NEW_TICKET_TPL`、`process.env.CS_REPLIED_TPL`。联系方式：`process.env.CS_WECHAT_ID`、`process.env.CS_PHONE`（可空，与小程序 `config.js` 运营自行保持一致）。运营回复通知 page：`pages/contact/contact`；新工单 page：`pages/admin/inbox/inbox`。

内存 db 要求：`where({ openid, status: _.neq('closed') })` 在测试里用 JS 过滤 `status !== 'closed'` 即可；条件 `update` 若当前 status 不匹配返回 `{ stats: { updated: 0 } }`。

- [ ] **Step 1: Write failing `csStore.test.js`**

覆盖：`csHistory` 两次调用欢迎语仍一条；`csSend` claim 后 `csAdminList` 默认待处理为空；自由输入后待处理有一条；`notifyAdminsFn` throw 时 send 仍 ok；`csAdminReply` 后用户 history 看得到 operator；对 `open` 线程 `csAdminReply` 得 `INVALID_STATE`；关闭后再 `csSend` 得到新 thread id。

假 db 写在测试文件顶部，不要放到生产 `csStore.js`。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test cloudfunctions/cs/lib/csStore.test.js`

Expected: FAIL，`csStore` 不存在。

- [ ] **Step 3: Implement `csStore.js` 与 `index.js`**

`csStore.js` 只收 `db` 与纯数据，不 `require('wx-server-sdk')`。`index.js` 负责 cloud、checkText、ticket、把 `notify*.send` 包成 fn 传入。用户传入的 `threadId` 若存在必须属于该 openid，否则 `FORBIDDEN`。

`index.js` dispatch：

`csHistory` | `csSend` | `csEscalate` | `csAdminList` | `csAdminGet` | `csAdminReply` | `csAdminClose` | `csRegisterNotify`

未知 action → `UNKNOWN_ACTION`。

- [ ] **Step 4: Run tests**

Run: `node --test cloudfunctions/cs/lib/csThreadState.test.js cloudfunctions/cs/lib/csFaq.test.js cloudfunctions/cs/lib/csSendFlow.test.js cloudfunctions/cs/lib/notify.test.js cloudfunctions/cs/lib/csStore.test.js`

Expected: PASS

在微信开发者工具上传云函数 `cs`，环境变量至少设 `ADMIN_PIN`（可与 catalog 相同）。本步不算自动化，失败则补 `index.js` 导出。

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/cs
git commit -m "$(cat <<'EOF'
feat(cs): 客服云函数落库会话与运营回复

EOF
)"
```

---

### Task 6: C 端客服 tab

**Files:**
- Modify: `miniprogram/utils/api.js` — 增加 `cs(data)`，与 `catalog` 相同但 `name: 'cs'`
- Modify: `miniprogram/pages/contact/contact.js`
- Modify: `miniprogram/pages/contact/contact.wxml` — `role` 使用 `user|assistant|operator|system`；气泡左侧：非 `user`；`item.account` 改为 `item.meta.account`；`id="m{{item._id}}"`；底部常驻「转人工」按钮（不要 `open-type="contact"`）
- Modify: `miniprogram/pages/contact/contact.wxss` — `.msg.assistant` / `.operator` / `.system` 复用原 `.staff` 样式；删除对 `.staff` 的依赖或让 `.staff` 别名等于 assistant

**Interfaces:**
- Consumes: `csHistory`、`csSend`、`csEscalate`
- Produces: 页面 `onShow` → `cs({ action: 'csHistory' })` → `setData({ thread, messages, hours })`。`hours` 来自 `config.contact.hours`（展示用）。快捷条仍读 `config.contact.faqs` 的 title，点选时 `csSend` 带对应 `faqId`。领取账号：`wx.getStorageSync('hqh_support_account')` 没有则生成 `YD` + 时间戳后 6 位 + 四位随机（与现网 `makeAccount` 相同），`setStorage` 后 `csSend({ action:'csSend', text:'领取账号', faqId:'claim', account })`。发送：`requestSubscribeMessage` 的 `tmplIds` 读 `miniprogram/config.js` 新增 `contact.replyTplId`（可空字符串，空则不调用订阅 API），无论成功失败都 `csSend`。转人工：同样先尝试订阅再 `csEscalate`。`waiting_human`/`human` 输入框仍显示。不要调用 `catalog.submitSupport`。不要 `button open-type="contact"`。

- [ ] **Step 1: 改 `api.js` 导出 `cs`**

```js
function cs(data) {
  return wx.cloud
    .callFunction({ name: 'cs', data })
    .then((res) => {
      const result = res.result;
      if (!result || result.ok === false) {
        const err = new Error((result && result.message) || '请求失败');
        err.code = result && result.code;
        throw err;
      }
      return result;
    });
}
```

`module.exports` 增加 `cs`。

- [ ] **Step 2: 重写 contact 页为服务端时间线**

`mapMessage`：把 `meta.account` 提到渲染字段 `account`；`meta.actions` 提到 `actions`。`anchor` 用最后一条 `_id`。

出错 toast `err.message`。

- [ ] **Step 3: 手测（开发者工具）**

首次进客服 tab 有欢迎语；重启小程序欢迎语仍一条；领取账号可复制且待处理列表为空（需先完成 Task 7 的列表，或云开发控制台看 `cs_threads.status` 仍为 `open`）。确认 wxml 无 `open-type="contact"`。

- [ ] **Step 4: Commit**

```bash
git add miniprogram/utils/api.js miniprogram/pages/contact miniprogram/config.js
git commit -m "$(cat <<'EOF'
feat(cs): 客服 tab 改为云端会话时间线

EOF
)"
```

`config.js` 增加：

```js
replyTplId: '',
```

放在 `contact` 对象内。正式环境把用户「客服已回复」模板 ID 填这里；云函数发送仍只认环境变量 `CS_REPLIED_TPL`（两端填同一个 ID）。

---

### Task 7: 运营工单页、登录订阅、README

**Files:**
- Modify: `miniprogram/pages/admin/inbox/inbox.js` / `inbox.wxml` / `inbox.json`（标题改为「客服工单」）
- Create: `miniprogram/pages/admin/ticket/ticket.js` / `ticket.wxml` / `ticket.json` / `ticket.wxss`
- Modify: `miniprogram/app.json` — `pages` 增加 `pages/admin/ticket/ticket`（写在 `inbox` 后面）
- Modify: `miniprogram/pages/admin/home/home.js` / `home.wxml` — 入口文案「客服工单」；角标改为待处理条数（`cs({ action:'csAdminList' })` 的 `threads.length`，需 ticket：在 `api.js` 增加 `csAdmin(data)` = `cs(Object.assign({ ticket: getTicket() }, data))`）
- Modify: `miniprogram/pages/admin/login/login.js` — `adminLogin` 成功 `setTicket` 后：若 `config.contact.newTicketTplId` 非空则 `requestSubscribeMessage`，然后 `csAdmin({ action: 'csRegisterNotify' })`（订阅失败仍 register，openid 以云函数上下文为准），再 `redirectTo` 工作台
- Modify: `README.md` — initDb 集合名单加上三集合；部署 `cs`；`ADMIN_PIN`；`CS_NEW_TICKET_TPL` / `CS_REPLIED_TPL`；客服与运营入口描述按新行为改；检索单测命令追加 `cloudfunctions/cs/lib/*.test.js`
- Modify: `miniprogram/config.js` — `contact.newTicketTplId: ''`

**Interfaces:**
- Consumes: `csAdminList`、`csAdminGet`、`csAdminReply`、`csAdminClose`、`csRegisterNotify`
- Produces: 列表筛 `waiting_human` | `human` | `closed`。点行进入 `/pages/admin/ticket/ticket?id=`。详情展示时间线，回复走 `csAdminReply`，关闭走 `csAdminClose`。可选只读：`catalog` `adminListSupport` 按当前线程 `openid` 过滤旧留言（无则隐藏）。`UNAUTHORIZED` 跳登录。

- [ ] **Step 1: 加 `csAdmin` 并改 inbox / ticket / home / login**

inbox 默认 `status: 'waiting_human'`，三个 chip 切换。空态文案：「还没有待处理工单。」

ticket.json：`navigationBarTitleText` 为「工单」。

- [ ] **Step 2: 更新 README 客服与单测段落**

把「客服留言」改成工单；写明 C 端不再写 `support_messages`；订阅模板申请后把 ID 配到云函数环境变量和小程序 `config.js` 的两个 tpl 字段。

- [ ] **Step 3: 手测全路径**

- 领取账号、怎么找视频：待处理为空。
- 自由打字或转人工：待处理出现；运营回复；用户再进客服 tab 能看见。
- 关闭后再发为新线程。
- 口令错误/过期回登录。
- 模板 ID 留空：回复与转人工仍成功。
- 无 `open-type="contact"`。

Run: `node --test cloudfunctions/cs/lib/csThreadState.test.js cloudfunctions/cs/lib/csFaq.test.js cloudfunctions/cs/lib/csSendFlow.test.js cloudfunctions/cs/lib/notify.test.js cloudfunctions/cs/lib/csStore.test.js cloudfunctions/catalog/lib/ensureCollections.test.js`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add miniprogram/utils/api.js miniprogram/pages/admin miniprogram/app.json miniprogram/config.js README.md
git commit -m "$(cat <<'EOF'
feat(cs): 运营工单回复与订阅登记

EOF
)"
```

---

## Spec 覆盖核对

| 规格条目 | 任务 |
| --- | --- |
| 状态机四态与非法转移 | Task 1 |
| 白名单不进待处理、打字/转人工 escalate | Task 2、5、6 |
| `cs_threads` / `cs_messages` / `admin_notify_subscribers` + initDb | Task 3 |
| 欢迎语只在 history 创建一次 | Task 5、6 |
| 云函数 `cs` 用户/运营 action | Task 5 |
| 条件更新防并发 | Task 5 `csStore` |
| 订阅失败不回滚 | Task 4、5 |
| C 端时间线、常驻转人工、无原生客服按钮 | Task 6 |
| 领取账号 storage + meta | Task 2、6 |
| 运营列表/回复/关闭 | Task 7 |
| 登录订新工单 | Task 7 |
| 旧 `support_messages` 只读可选 | Task 7 |
| 内容安全 / BAD_INPUT / UNAUTHORIZED | Task 5、6、7 |
| 不接 Agent | 全计划无 `agent` 云函数 |
| README 与单测 | Task 7 |
