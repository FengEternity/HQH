# 运营新工单通知订阅 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 多个运营人员共用同一套客服工单，每个微信独立累计一次性订阅额度，并可立即停止接收新工单通知。

**Architecture:** 订阅文档仍放在 `admin_notify_subscribers`。`csStore` 负责开关、额度、预扣和发送结果；`notify.js` 只识别订阅错误码和构造模板数据。`ticketing` 入口把当前 OpenID 与环境变量模板接进去。工作台只在微信返回 `accept` 后登记，登录不再参与通知登记。

**Tech Stack:** 微信云开发 `wx-server-sdk`、云数据库、一次性订阅消息、原生小程序、`node --test`。

## Global Constraints

- 规格：`docs/superpowers/specs/2026-10-16-admin-notify-subscription-design.md`。
- 保持单一客服工作区；继续使用统一运营口令。
- 不新建集合，不清理历史订阅文档。
- 历史文档没有 `enabled === true` 时不发送。
- 只有客户端确认 `accept` 后才调用 `csRegisterNotify`。
- 登录不调用 `requestSubscribeMessage`，也不调用 `csRegisterNotify`。
- 停止接收只把 `enabled` 设为 `false`，`quota` 不变。
- 同一模板再次允许时 `quota` 加 1；模板 ID 变化时 `quota` 设为 1。
- 发送前按 `enabled === true`、`quota > 0`、`templateId === CS_NEW_TICKET_TPL` 条件预扣。
- 发送成功保持已扣额度；错误码 `43101` 把 `quota` 设为 0 且 `enabled` 保持 `true`；其他失败把 `quota` 加回 1。
- 查询候选时不分 `orderBy`。
- 通知失败不回滚工单；用户侧「客服已回复」订阅维持现状。
- 不新增运营账号，不把票据绑定到 OpenID。
- 在 `hotfix-cs-notify` 上实现。不要在 `main` 上 commit。
- Commit message 使用简体中文，不写 `DES-*` / `ANAL-*`。

## 文件地图

| 路径 | 职责 |
| --- | --- |
| `cloudfunctions/ticketing/lib/csStore.test.js` | 扩展内存数据库的 `gt` / `inc`，覆盖额度与发送结果 |
| `cloudfunctions/ticketing/lib/csStore.js` | 订阅记录、候选查询、预扣、发送编排 |
| `cloudfunctions/ticketing/lib/notify.js` | 订阅错误码与新工单模板数据 |
| `cloudfunctions/ticketing/lib/notify.test.js` | 错误码识别 |
| `cloudfunctions/ticketing/index.js` | 管理接口与新工单发送入口 |
| `miniprogram/pages/admin/login/login.js` | 登录只建立会话 |
| `miniprogram/pages/admin/login/login.test.js` | 登录不再登记通知 |
| `miniprogram/pages/admin/home/home.js` | 状态、允许、停止 |
| `miniprogram/pages/admin/home/home.wxml` | 通知卡片与停止按钮 |
| `miniprogram/pages/admin/home/home.wxss` | 停止按钮位于卡片内部 |
| `miniprogram/pages/admin/home/home.test.js` | 允许才登记，停止不触发订阅 |

---

### Task 1: 订阅记录与额度

**Files:**
- Modify: `cloudfunctions/ticketing/lib/csStore.test.js`
- Modify: `cloudfunctions/ticketing/lib/csStore.js`
- Test: `cloudfunctions/ticketing/lib/csStore.test.js`

**Interfaces:**
- Consumes: 现有内存数据库 `makeMemoryDb`
- Produces:
  - `csRegisterNotify(db, { openid, templateId, now })` → `{ ok: true, enabled: true, quota: number }`；空 `openid` 或空 `templateId` 抛 `code === 'BAD_INPUT'`
  - `csUnregisterNotify(db, { openid, now })` → `{ ok: true, enabled: false, quota: number }`
  - `readNotifyStatus(db, { openid })` → `{ enabled: boolean, quota: number }`
  - `listNotifyCandidates(db, { templateId })` → 文档数组
  - `reserveNotifySend(db, { id, templateId, now })` → 布尔值，表示本次预扣是否成功
  - `finishNotifySend(db, { id, outcome, errorCode, now })`，`outcome` 为 `'sent' | 'unsubscribed' | 'failed'`

- [ ] **Step 1: 从 main 迁出热修分支**

Run:

```bash
git checkout main
git checkout -b hotfix-cs-notify
```

Expected: `git status --short --branch` 显示 `## hotfix-cs-notify`。

- [ ] **Step 2: 写失败测试**

把 `csStore.test.js` 顶部导入改为：

```js
const {
  csAdminList,
  csAdminGet,
  csAdminReply,
  csAdminClose,
  csHistory,
  csSend,
  csRegisterNotify,
  csUnregisterNotify,
  readNotifyStatus,
  listNotifyCandidates,
  reserveNotifySend,
  finishNotifySend,
} = require('./csStore');
```

在 `matches` 中保留 `neq`，并加上：

```js
if (expected && expected.__op === 'gt') {
  return Number(doc[key]) > expected.value;
}
```

把两处 `Object.assign(item, data)` 改成调用同一个 `applyPatch(item, data)`：

```js
function applyPatch(item, data) {
  Object.entries(data || {}).forEach(([key, value]) => {
    if (value && value.__op === 'inc') {
      item[key] = (Number(item[key]) || 0) + value.value;
      return;
    }
    item[key] = value;
  });
}
```

`command` 增加：

```js
gt(value) {
  return { __op: 'gt', value };
},
inc(value) {
  return { __op: 'inc', value };
},
```

文件末尾追加：

```js
test('空身份或空模板不能登记通知', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    csRegisterNotify(db, { openid: '', templateId: 'tpl', now: 1 }),
    { code: 'BAD_INPUT' },
  );
  await assert.rejects(
    csRegisterNotify(db, { openid: 'wx-1', templateId: '', now: 1 }),
    { code: 'BAD_INPUT' },
  );
});

test('同一模板重复允许会累加额度，换模板后额度重新从 1 开始', async () => {
  const db = makeMemoryDb();
  const first = await csRegisterNotify(db, {
    openid: 'wx-1',
    templateId: 'tpl-a',
    now: 1,
  });
  const second = await csRegisterNotify(db, {
    openid: 'wx-1',
    templateId: 'tpl-a',
    now: 2,
  });
  const replaced = await csRegisterNotify(db, {
    openid: 'wx-1',
    templateId: 'tpl-b',
    now: 3,
  });

  assert.equal(first.quota, 1);
  assert.equal(second.quota, 2);
  assert.deepEqual(replaced, { ok: true, enabled: true, quota: 1 });
  assert.deepEqual(await listNotifyCandidates(db, { templateId: 'tpl-a' }), []);
  const [current] = await listNotifyCandidates(db, { templateId: 'tpl-b' });
  assert.equal(current.lastResult, '');
  assert.equal(current.lastErrorCode, '');
});

test('停止接收后保留额度，历史记录不会成为候选', async () => {
  const db = makeMemoryDb();
  await db.collection('admin_notify_subscribers').add({
    data: { openid: 'legacy', createdAt: 1, updatedAt: 1 },
  });
  await csRegisterNotify(db, { openid: 'wx-1', templateId: 'tpl', now: 2 });
  await csRegisterNotify(db, { openid: 'wx-1', templateId: 'tpl', now: 3 });
  const stopped = await csUnregisterNotify(db, { openid: 'wx-1', now: 4 });

  assert.deepEqual(stopped, { ok: true, enabled: false, quota: 2 });
  assert.deepEqual(await listNotifyCandidates(db, { templateId: 'tpl' }), []);
  assert.deepEqual(await readNotifyStatus(db, { openid: 'wx-1' }), {
    enabled: false,
    quota: 2,
  });
  assert.deepEqual(await csUnregisterNotify(db, { openid: 'missing', now: 5 }), {
    ok: true,
    enabled: false,
    quota: 0,
  });
});

test('同一条额度只能预扣一次，并按发送结果结算', async () => {
  const db = makeMemoryDb();
  await csRegisterNotify(db, { openid: 'wx-1', templateId: 'tpl', now: 1 });
  const [candidate] = await listNotifyCandidates(db, { templateId: 'tpl' });

  assert.equal(
    await reserveNotifySend(db, { id: candidate._id, templateId: 'tpl', now: 2 }),
    true,
  );
  assert.equal(
    await reserveNotifySend(db, { id: candidate._id, templateId: 'tpl', now: 3 }),
    false,
  );
  await finishNotifySend(db, {
    id: candidate._id,
    outcome: 'failed',
    errorCode: 40037,
    now: 4,
  });
  assert.equal((await readNotifyStatus(db, { openid: 'wx-1' })).quota, 1);

  await reserveNotifySend(db, { id: candidate._id, templateId: 'tpl', now: 5 });
  await finishNotifySend(db, {
    id: candidate._id,
    outcome: 'unsubscribed',
    errorCode: 43101,
    now: 6,
  });
  assert.deepEqual(await readNotifyStatus(db, { openid: 'wx-1' }), {
    enabled: true,
    quota: 0,
  });

  await csRegisterNotify(db, { openid: 'wx-1', templateId: 'tpl', now: 7 });
  await reserveNotifySend(db, { id: candidate._id, templateId: 'tpl', now: 8 });
  await finishNotifySend(db, { id: candidate._id, outcome: 'sent', now: 9 });
  const saved = await db.collection('admin_notify_subscribers').doc(candidate._id).get();
  assert.equal(saved.data.quota, 0);
  assert.equal(saved.data.enabled, true);
  assert.equal(saved.data.lastResult, 'sent');
  assert.equal(saved.data.lastErrorCode, '');
});
```

- [ ] **Step 3: 运行测试并确认失败**

Run:

```bash
node --test cloudfunctions/ticketing/lib/csStore.test.js
```

Expected: FAIL，`csRegisterNotify` 未按新签名导出或额度断言失败。

- [ ] **Step 4: 实现订阅记录**

`ERROR_MESSAGES` 增加 `BAD_INPUT: '输入内容不正确'`。

用下面的实现替换现有 `csRegisterNotify`，并导出全部新函数：

```js
function assertIdentity(openid, templateId) {
  if (!openid || !templateId) {
    throw codedError('BAD_INPUT');
  }
}

async function findSubscriber(db, openid) {
  const existing = await db.collection(SUBSCRIBERS).where({ openid }).limit(1).get();
  return (existing.data && existing.data[0]) || null;
}

async function csRegisterNotify(db, { openid, templateId, now }) {
  assertIdentity(openid, templateId);
  const current = await findSubscriber(db, openid);
  if (!current) {
    const data = {
      openid,
      enabled: true,
      quota: 1,
      templateId,
      lastResult: '',
      lastErrorCode: '',
      createdAt: now,
      updatedAt: now,
    };
    await db.collection(SUBSCRIBERS).add({ data });
    return { ok: true, enabled: true, quota: 1 };
  }
  const sameTemplate = current.templateId === templateId;
  await db.collection(SUBSCRIBERS).doc(current._id).update({
    data: {
      enabled: true,
      quota: sameTemplate ? db.command.inc(1) : 1,
      templateId,
      lastResult: '',
      lastErrorCode: '',
      updatedAt: now,
    },
  });
  const saved = await db.collection(SUBSCRIBERS).doc(current._id).get();
  return { ok: true, enabled: true, quota: Number(saved.data.quota) || 0 };
}

async function csUnregisterNotify(db, { openid, now }) {
  if (!openid) {
    throw codedError('BAD_INPUT');
  }
  const current = await findSubscriber(db, openid);
  if (!current) {
    return { ok: true, enabled: false, quota: 0 };
  }
  await db.collection(SUBSCRIBERS).doc(current._id).update({
    data: {
      enabled: false,
      lastResult: 'stopped',
      lastErrorCode: '',
      updatedAt: now,
    },
  });
  return { ok: true, enabled: false, quota: Number(current.quota) || 0 };
}

async function readNotifyStatus(db, { openid }) {
  if (!openid) {
    throw codedError('BAD_INPUT');
  }
  const current = await findSubscriber(db, openid);
  if (!current) {
    return { enabled: false, quota: 0 };
  }
  return {
    enabled: current.enabled === true,
    quota: Number(current.quota) || 0,
  };
}

async function listNotifyCandidates(db, { templateId }) {
  if (!templateId) {
    return [];
  }
  return listWhere(db.collection(SUBSCRIBERS), {
    enabled: true,
    quota: db.command.gt(0),
    templateId,
  });
}

async function reserveNotifySend(db, { id, templateId, now }) {
  const result = await db.collection(SUBSCRIBERS).where({
    _id: id,
    enabled: true,
    quota: db.command.gt(0),
    templateId,
  }).update({
    data: {
      quota: db.command.inc(-1),
      updatedAt: now,
    },
  });
  return Boolean(result.stats && result.stats.updated > 0);
}

async function finishNotifySend(db, { id, outcome, errorCode, now }) {
  if (outcome === 'sent') {
    await db.collection(SUBSCRIBERS).doc(id).update({
      data: { lastResult: 'sent', lastErrorCode: '', updatedAt: now },
    });
    return;
  }
  if (outcome === 'unsubscribed') {
    await db.collection(SUBSCRIBERS).doc(id).update({
      data: {
        quota: 0,
        enabled: true,
        lastResult: 'unsubscribed',
        lastErrorCode: 43101,
        updatedAt: now,
      },
    });
    return;
  }
  if (outcome === 'failed') {
    await db.collection(SUBSCRIBERS).doc(id).update({
      data: {
        quota: db.command.inc(1),
        lastResult: 'failed',
        lastErrorCode: errorCode || '',
        updatedAt: now,
      },
    });
    return;
  }
  throw codedError('BAD_INPUT');
}
```

`module.exports` 加入 `csRegisterNotify`、`csUnregisterNotify`、`readNotifyStatus`、`listNotifyCandidates`、`reserveNotifySend`、`finishNotifySend`。

- [ ] **Step 5: 运行测试并确认通过**

Run:

```bash
node --test cloudfunctions/ticketing/lib/csStore.test.js
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add cloudfunctions/ticketing/lib/csStore.js cloudfunctions/ticketing/lib/csStore.test.js docs/superpowers/specs/2026-10-16-admin-notify-subscription-design.md docs/superpowers/plans/2026-10-16-admin-notify-subscription.md
git commit -m "$(cat <<'EOF'
feat(cs): 按微信记录新工单通知开关和额度

EOF
)"
```

---

### Task 2: 预扣后发送

**Files:**
- Modify: `cloudfunctions/ticketing/lib/notify.js`
- Modify: `cloudfunctions/ticketing/lib/notify.test.js`
- Modify: `cloudfunctions/ticketing/lib/csStore.js`
- Modify: `cloudfunctions/ticketing/lib/csStore.test.js`
- Test: `cloudfunctions/ticketing/lib/notify.test.js`
- Test: `cloudfunctions/ticketing/lib/csStore.test.js`

**Interfaces:**
- Consumes: Task 1 的候选、预扣、结算函数
- Produces:
  - `subscribeErrorCode(error)` → 数字；`43101` 优先识别，无错误码时返回 `0`
  - `newTicketData(now)` → 现有 `ticketCard('待处理', now)`
  - `deliverAdminNotifications(db, { templateId, now, page, send })` → `{ ok: true, sent, skipped }`

- [ ] **Step 1: 写错误码失败测试**

`notify.test.js` 导入 `subscribeErrorCode`、`newTicketData`，并追加：

```js
it('recognizes 43101 from either errCode or errMsg', () => {
  assert.equal(subscribeErrorCode({ errCode: 43101 }), 43101);
  assert.equal(subscribeErrorCode({ errCode: '43101' }), 43101);
  assert.equal(subscribeErrorCode(new Error('errCode: 43101')), 43101);
  assert.equal(subscribeErrorCode({ errCode: 40037 }), 40037);
  assert.equal(subscribeErrorCode(new Error('quota')), 0);
});

it('builds the same new-ticket card used by notifyNewTicket', () => {
  const now = Date.parse('2026-09-20T12:34:00+08:00');
  assert.equal(newTicketData(now).phrase17.value, '待处理');
  assert.equal(newTicketData(now).time16.value, '2026年9月20日 12:34');
});
```

- [ ] **Step 2: 运行错误码测试并确认失败**

Run:

```bash
node --test cloudfunctions/ticketing/lib/notify.test.js
```

Expected: FAIL，`subscribeErrorCode` 未导出。

- [ ] **Step 3: 实现错误码识别**

在 `notify.js` 增加并导出：

```js
function normalizeCode(value) {
  if (value === undefined || value === null || value === '' || value === 0 || value === '0') {
    return 0;
  }
  const code = Number(value);
  return Number.isFinite(code) ? code : 0;
}

function subscribeErrorCode(error) {
  if (!error || typeof error !== 'object') {
    return 0;
  }
  const direct = error.errCode !== undefined ? error.errCode : error.errcode;
  if (normalizeCode(direct) === 43101) {
    return 43101;
  }
  const text = String(error.errMsg || error.message || '');
  if (/(?:^|\D)43101(?:\D|$)/.test(text)) {
    return 43101;
  }
  return normalizeCode(direct);
}

function newTicketData(now) {
  return ticketCard('待处理', now);
}
```

`module.exports` 加入 `subscribeErrorCode`、`newTicketData`。不要修改 `notifyReplied`。

- [ ] **Step 4: 写发送编排失败测试**

`csStore.test.js` 再导入 `deliverAdminNotifications`，追加：

```js
test('没有模板时不发送', async () => {
  const db = makeMemoryDb();
  let calls = 0;
  const result = await deliverAdminNotifications(db, {
    templateId: '',
    now: 1,
    page: 'pages/admin/inbox/inbox',
    send: async () => {
      calls += 1;
    },
  });
  assert.equal(calls, 0);
  assert.deepEqual(result, { ok: true, sent: 0, skipped: 0 });
});

test('只向有额度的当前模板发送，并按结果结算', async () => {
  const db = makeMemoryDb();
  await csRegisterNotify(db, { openid: 'ready', templateId: 'tpl', now: 1 });
  await csRegisterNotify(db, { openid: 'ready', templateId: 'tpl', now: 2 });
  await csRegisterNotify(db, { openid: 'stopped', templateId: 'tpl', now: 3 });
  await csUnregisterNotify(db, { openid: 'stopped', now: 4 });
  await db.collection('admin_notify_subscribers').add({
    data: { openid: 'legacy', createdAt: 1, updatedAt: 1 },
  });
  const sent = [];
  const result = await deliverAdminNotifications(db, {
    templateId: 'tpl',
    now: 5,
    page: 'pages/admin/inbox/inbox',
    send: async (payload) => {
      sent.push(payload.touser);
      if (payload.touser === 'ready') {
        return {};
      }
    },
  });

  assert.deepEqual(sent, ['ready']);
  assert.deepEqual(result, { ok: true, sent: 1, skipped: 0 });
  assert.equal((await readNotifyStatus(db, { openid: 'ready' })).quota, 1);
});

test('43101 归零，其他失败退回额度', async () => {
  const db = makeMemoryDb();
  await csRegisterNotify(db, { openid: 'gone', templateId: 'tpl', now: 1 });
  await csRegisterNotify(db, { openid: 'retry', templateId: 'tpl', now: 2 });
  await deliverAdminNotifications(db, {
    templateId: 'tpl',
    now: 3,
    page: 'pages/admin/inbox/inbox',
    send: async (payload) => {
      if (payload.touser === 'gone') {
        const error = new Error('user refuse');
        error.errCode = 43101;
        throw error;
      }
      const error = new Error('bad template');
      error.errCode = 40037;
      throw error;
    },
  });

  assert.deepEqual(await readNotifyStatus(db, { openid: 'gone' }), {
    enabled: true,
    quota: 0,
  });
  assert.deepEqual(await readNotifyStatus(db, { openid: 'retry' }), {
    enabled: true,
    quota: 1,
  });
});
```

保留现有「自由输入升级为待处理并在通知失败时仍成功」，不要删除或改写它。

- [ ] **Step 5: 运行发送测试并确认失败**

Run:

```bash
node --test cloudfunctions/ticketing/lib/csStore.test.js
```

Expected: FAIL，`deliverAdminNotifications` 未定义。

- [ ] **Step 6: 实现发送编排**

`csStore.js` 顶部增加：

```js
const { newTicketData, subscribeErrorCode } = require('./notify');
```

增加并导出：

```js
async function deliverAdminNotifications(db, { templateId, now, page, send }) {
  const candidates = await listNotifyCandidates(db, { templateId });
  let sent = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    const reserved = await reserveNotifySend(db, {
      id: candidate._id,
      templateId,
      now,
    });
    if (!reserved) {
      skipped += 1;
      continue;
    }
    try {
      const result = await send({
        touser: candidate.openid,
        templateId,
        page,
        data: newTicketData(now),
      });
      const code = subscribeErrorCode(result);
      if (code === 43101) {
        await finishNotifySend(db, {
          id: candidate._id,
          outcome: 'unsubscribed',
          errorCode: 43101,
          now,
        });
        skipped += 1;
      } else if (code) {
        await finishNotifySend(db, {
          id: candidate._id,
          outcome: 'failed',
          errorCode: code,
          now,
        });
        skipped += 1;
      } else {
        await finishNotifySend(db, { id: candidate._id, outcome: 'sent', now });
        sent += 1;
      }
    } catch (error) {
      const code = subscribeErrorCode(error);
      await finishNotifySend(db, {
        id: candidate._id,
        outcome: code === 43101 ? 'unsubscribed' : 'failed',
        errorCode: code,
        now,
      });
      skipped += 1;
    }
  }
  return { ok: true, sent, skipped };
}
```

- [ ] **Step 7: 运行测试并确认通过**

Run:

```bash
node --test cloudfunctions/ticketing/lib/notify.test.js cloudfunctions/ticketing/lib/csStore.test.js
```

Expected: PASS。

- [ ] **Step 8: Commit**

```bash
git add cloudfunctions/ticketing/lib/notify.js cloudfunctions/ticketing/lib/notify.test.js cloudfunctions/ticketing/lib/csStore.js cloudfunctions/ticketing/lib/csStore.test.js
git commit -m "$(cat <<'EOF'
feat(cs): 新工单通知先预扣额度，失败时按错误码结算

EOF
)"
```

---

### Task 3: 接上云函数入口

**Files:**
- Modify: `cloudfunctions/ticketing/index.js`
- Test: `cloudfunctions/ticketing/lib/csStore.test.js`

**Interfaces:**
- Consumes: `readNotifyStatus`、`csRegisterNotify`、`csUnregisterNotify`、`deliverAdminNotifications`、`readNewTicketTemplateId`
- Produces:
  - `csNotifyConfig` 返回 `{ ok: true, newTicketTplId, enabled, quota }`
  - `csRegisterNotify` 使用当前 OpenID 与 `CS_NEW_TICKET_TPL`
  - `csUnregisterNotify` 使用当前 OpenID
  - `notifyAdmins` 改为调用 `deliverAdminNotifications`

- [ ] **Step 1: 替换入口中的通知实现**

`index.js` 的导入改为同时引入：

```js
const {
  csHistory,
  csSend,
  csEscalate,
  csAdminList,
  csAdminGet,
  csAdminReply,
  csAdminClose,
  csRegisterNotify,
  csUnregisterNotify,
  readNotifyStatus,
  deliverAdminNotifications,
} = require('./lib/csStore');
```

删除 `index.js` 里直接读取 `admin_notify_subscribers` 的 `notifyAdmins`。替换为：

```js
function notifyAdmins(now) {
  return deliverAdminNotifications(db, {
    templateId: readNewTicketTemplateId(process.env),
    now,
    page: 'pages/admin/inbox/inbox',
    send: sendSubscribeMessage,
  });
}
```

`dispatch` 中三个分支改为：

```js
case 'csRegisterNotify':
  requireAdmin(event.ticket);
  return csRegisterNotify(db, {
    openid,
    templateId: readNewTicketTemplateId(process.env),
    now,
  });
case 'csUnregisterNotify':
  requireAdmin(event.ticket);
  return csUnregisterNotify(db, { openid, now });
case 'csNotifyConfig':
  requireAdmin(event.ticket);
  return Object.assign(
    { ok: true, newTicketTplId: readNewTicketTemplateId(process.env) },
    await readNotifyStatus(db, { openid }),
  );
```

`csSend` 现有的 `notifyAdminsFn` 异常捕获保持不变。

- [ ] **Step 2: 运行既有工单测试**

Run:

```bash
node --test cloudfunctions/ticketing/lib/csStore.test.js cloudfunctions/ticketing/lib/notify.test.js
```

Expected: PASS。入口文件没有独立测试；本步骤确认库函数没有被入口改动破坏。

- [ ] **Step 3: Commit**

```bash
git add cloudfunctions/ticketing/index.js
git commit -m "$(cat <<'EOF'
feat(cs): 按当前微信和当前模板收发新工单通知

EOF
)"
```

---

### Task 4: 登录不再登记通知

**Files:**
- Modify: `miniprogram/pages/admin/login/login.js`
- Modify: `miniprogram/pages/admin/login/login.test.js`
- Test: `miniprogram/pages/admin/login/login.test.js`

**Interfaces:**
- Consumes: 现有 `catalog({ action: 'adminLogin' })` 与 `setTicket`
- Produces: 登录成功后只保存票据并 `redirectTo` 工作台

- [ ] **Step 1: 替换登录测试**

用以下测试替换 `login.test.js` 中「拒绝订阅后仍登记」的用例：

```js
it('logs in without requesting or registering notifications', async () => {
  const events = [];
  global.wx = {
    requestSubscribeMessage() {
      events.push(['subscribe']);
      return Promise.resolve({ 'new-ticket-template': 'accept' });
    },
    redirectTo({ url }) {
      events.push(['redirect', url]);
    },
    showToast() {},
  };
  const { page, tickets } = loadPage({
    templateId: 'new-ticket-template',
    catalog: async () => ({ ok: true, ticket: 'ticket-1' }),
    ticketingAdmin: async (data) => {
      events.push(['register', data.action]);
      return { ok: true };
    },
  });
  page.data.pin = '1234';

  await page.onLogin();

  assert.deepEqual(tickets, ['ticket-1']);
  assert.deepEqual(events, [['redirect', '/pages/admin/home/home']]);
});
```

保留「登记失败也不显示登录失败」用例，但断言里不再允许出现 `register` 事件。该用例的 `ticketingAdmin` 可以继续抛错，登录仍必须跳转工作台。

- [ ] **Step 2: 运行登录测试并确认失败**

Run:

```bash
node --test miniprogram/pages/admin/login/login.test.js
```

Expected: FAIL，当前登录仍调用订阅和 `csRegisterNotify`。

- [ ] **Step 3: 删除登录中的订阅副作用**

`login.js` 删除 `ticketingAdmin`、`contact` 导入和整个 `requestNewTicketSubscription`。`onLogin` 成功分支改为：

```js
return catalog({ action: 'adminLogin', pin })
  .then((res) => {
    setTicket(res.ticket);
    wx.redirectTo({ url: '/pages/admin/home/home' });
  })
  .catch((err) => {
    wx.showToast({ title: err.message || '登录失败', icon: 'none' });
  });
```

- [ ] **Step 4: 运行登录测试并确认通过**

Run:

```bash
node --test miniprogram/pages/admin/login/login.test.js
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add miniprogram/pages/admin/login/login.js miniprogram/pages/admin/login/login.test.js
git commit -m "$(cat <<'EOF'
fix(admin): 登录只进入工作台，不再登记新工单通知

EOF
)"
```

---

### Task 5: 工作台允许与停止

**Files:**
- Modify: `miniprogram/pages/admin/home/home.js`
- Modify: `miniprogram/pages/admin/home/home.wxml`
- Create: `miniprogram/pages/admin/home/home.wxss`
- Modify: `miniprogram/pages/admin/home/home.test.js`
- Test: `miniprogram/pages/admin/home/home.test.js`

**Interfaces:**
- Consumes: `csNotifyConfig`、`csRegisterNotify`、`csUnregisterNotify`
- Produces: 页面状态 `notifyLabel`、`notifyEnabled`；点击卡片只在 `accept` 后登记；`stopNotify` 不调用订阅接口

- [ ] **Step 1: 写工作台失败测试**

在 `home.js` 可测范围内，把纯函数放在文件顶部并导出给测试。`home.test.js` 在 `require(pagePath)` 后读取：

```js
const { notifyLabelText } = require(pagePath);
```

由于页面文件当前只注册 `Page`，实现时在 `module.exports = { notifyLabelText }` 之前定义：

```js
function notifyLabelText(templateId, enabled, quota) {
  if (!templateId) {
    return '未配置';
  }
  if (!enabled) {
    return '未开启';
  }
  if (Number(quota) > 0) {
    return '还可接收 ' + quota + ' 条';
  }
  return '额度已用完';
}
```

测试追加：

```js
it('shows the four notification states', () => {
  global.Page = () => {};
  delete require.cache[pagePath];
  const { notifyLabelText } = require(pagePath);
  assert.equal(notifyLabelText('', false, 0), '未配置');
  assert.equal(notifyLabelText('tpl', false, 2), '未开启');
  assert.equal(notifyLabelText('tpl', true, 2), '还可接收 2 条');
  assert.equal(notifyLabelText('tpl', true, 0), '额度已用完');
});

it('does not register when the operator rejects, is banned, or the request fails', async () => {
  for (const outcome of ['reject', 'ban', 'filter', 'fail']) {
    const events = [];
    global.wx = {
      getAccountInfoSync() {
        return { miniProgram: { envVersion: 'develop' } };
      },
      requestSubscribeMessage({ success, fail }) {
        events.push(['subscribe']);
        if (outcome === 'fail') {
          fail({ errMsg: 'requestSubscribeMessage:fail' });
          return;
        }
        success({ 'tpl-new': outcome });
      },
      navigateTo() {},
      redirectTo() {},
      showToast({ title }) {
        events.push(['toast', title]);
      },
    };
    const page = loadPage({
      ticketingAdmin: async (data) => {
        events.push(['api', data.action]);
        if (data.action === 'csNotifyConfig') {
          return { ok: true, newTicketTplId: 'tpl-new', enabled: false, quota: 0 };
        }
        if (data.action === 'csAdminList') {
          return { ok: true, threads: [] };
        }
        return { ok: true, enabled: true, quota: 1 };
      },
    });

    await page.onShow();
    await page.bindNotify();

    assert.equal(
      events.some((item) => item[0] === 'api' && item[1] === 'csRegisterNotify'),
      false,
    );
    assert.deepEqual(
      events.filter((item) => item[0] === 'toast'),
      [['toast', '未允许，这个微信收不到通知']],
    );
  }
});

it('registers one quota after accept and stops without subscribing again', async () => {
  const events = [];
  global.wx = {
    getAccountInfoSync() {
      return { miniProgram: { envVersion: 'develop' } };
    },
    requestSubscribeMessage({ success }) {
      events.push(['subscribe']);
      success({ 'tpl-new': 'accept' });
    },
    navigateTo() {},
    redirectTo() {},
    showToast({ title }) {
      events.push(['toast', title]);
    },
  };
  const page = loadPage({
    ticketingAdmin: async (data) => {
      events.push(['api', data.action]);
      if (data.action === 'csNotifyConfig') {
        return { ok: true, newTicketTplId: 'tpl-new', enabled: true, quota: 1 };
      }
      if (data.action === 'csRegisterNotify') {
        return { ok: true, enabled: true, quota: 2 };
      }
      if (data.action === 'csUnregisterNotify') {
        return { ok: true, enabled: false, quota: 2 };
      }
      return { ok: true, threads: [] };
    },
  });

  await page.onShow();
  assert.equal(page.data.notifyLabel, '还可接收 1 条');
  assert.equal(page.data.notifyEnabled, true);
  await page.bindNotify();
  assert.equal(page.data.notifyLabel, '还可接收 2 条');
  await page.stopNotify();
  assert.equal(page.data.notifyLabel, '未开启');
  assert.equal(page.data.notifyEnabled, false);
  assert.deepEqual(events.filter((item) => item[0] === 'subscribe'), [['subscribe']]);
});

it('keeps the current state when stopping fails', async () => {
  global.wx = {
    getAccountInfoSync() {
      return { miniProgram: { envVersion: 'develop' } };
    },
    requestSubscribeMessage() {},
    navigateTo() {},
    redirectTo() {},
    showToast({ title }) {
      this.toast = title;
    },
  };
  const page = loadPage({
    ticketingAdmin: async (data) => {
      if (data.action === 'csNotifyConfig') {
        return { ok: true, newTicketTplId: 'tpl-new', enabled: true, quota: 1 };
      }
      if (data.action === 'csUnregisterNotify') {
        throw new Error('stop failed');
      }
      return { ok: true, threads: [] };
    },
  });

  await page.onShow();
  await page.stopNotify();

  assert.equal(page.data.notifyEnabled, true);
  assert.equal(page.data.notifyLabel, '还可接收 1 条');
  assert.equal(global.wx.toast, '停止失败');
});
```

把现有「允许后已绑定」断言改成 toast 以「已开启」开头，并把无模板时的初始文案断言从「去绑定」改为「未配置」。无模板用例仍断言不调用订阅接口、toast 为「未配置通知模板」。

- [ ] **Step 2: 运行工作台测试并确认失败**

Run:

```bash
node --test miniprogram/pages/admin/home/home.test.js
```

Expected: FAIL，`notifyLabelText` 或 `stopNotify` 不存在，拒绝时仍调用登记。

- [ ] **Step 3: 实现工作台状态**

`home.js` 初始数据改为 `notifyLabel: '未开启'`、`notifyEnabled: false`。增加 `notifyLabelText`，并用它更新状态：

```js
applyNotify(templateId, enabled, quota) {
  this.setData({
    newTicketTplId: templateId || '',
    notifyEnabled: Boolean(enabled),
    notifyLabel: notifyLabelText(templateId, enabled, quota),
  });
},
```

`loadNotifyTemplate` 在拿到 `csNotifyConfig` 后调用 `applyNotify(result.newTicketTplId, result.enabled, result.quota)`。

用下面的实现替换 `bindNotify`。`settled` 必须保留，避免微信同时触发回调和 Promise 时把一次允许登记成两份额度：

```js
bindNotify() {
  const templateId = this.data.newTicketTplId;
  if (!templateId) {
    wx.showToast({ title: '未配置通知模板', icon: 'none' });
    return;
  }
  let settled = false;
  const finish = (result) => {
    if (settled) {
      return;
    }
    settled = true;
    if (!result || result[templateId] !== 'accept') {
      wx.showToast({ title: '未允许，这个微信收不到通知', icon: 'none' });
      return;
    }
    return ticketingAdmin({ action: 'csRegisterNotify' })
      .then((registered) => {
        this.applyNotify(templateId, registered.enabled, registered.quota);
        wx.showToast({
          title: '已开启，还可接收 ' + registered.quota + ' 条',
          icon: 'none',
        });
      })
      .catch(() => {
        wx.showToast({ title: '通知状态更新失败', icon: 'none' });
      });
  };
  try {
    let pending;
    const request = wx.requestSubscribeMessage({
      tmplIds: [templateId],
      success: (result) => {
        pending = finish(result);
      },
      fail: () => {
        pending = finish(null);
      },
    });
    if (request && typeof request.then === 'function') {
      return request.then((result) => finish(result), () => finish(null));
    }
    return pending;
  } catch (err) {
    return finish(null);
  }
},
```

增加：

```js
stopNotify() {
  return ticketingAdmin({ action: 'csUnregisterNotify' })
    .then((result) => {
      this.applyNotify(this.data.newTicketTplId, result.enabled, result.quota);
    })
    .catch(() => {
      wx.showToast({ title: '停止失败', icon: 'none' });
    });
},
```

文件末尾增加 `module.exports = { notifyLabelText };`。

`home.wxml` 的通知卡片改为：

```xml
<view class="hub-item hub-item-notify">
  <view class="notify-main" bindtap="bindNotify">
    <view>
      <view class="tile-title">接收新工单通知</view>
      <view class="muted">每次允许只能收一条。停止后不再推送。</view>
      <view wx:if="{{notifyEnabled}}" class="notify-stop" catchtap="stopNotify">停止接收</view>
    </view>
    <text class="chip">{{notifyLabel}}</text>
  </view>
</view>
```

创建 `home.wxss`：

```css
.hub-item-notify {
  display: block;
}

.notify-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16rpx;
}

.notify-stop {
  margin-top: 12rpx;
  color: #3f3f46;
  font-size: 26rpx;
}
```

- [ ] **Step 4: 运行工作台测试并确认通过**

Run:

```bash
node --test miniprogram/pages/admin/home/home.test.js miniprogram/pages/admin/login/login.test.js cloudfunctions/ticketing/lib/csStore.test.js cloudfunctions/ticketing/lib/notify.test.js
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add miniprogram/pages/admin/home/home.js miniprogram/pages/admin/home/home.wxml miniprogram/pages/admin/home/home.wxss miniprogram/pages/admin/home/home.test.js
git commit -m "$(cat <<'EOF'
fix(admin): 只在允许后接收下一条新工单通知

EOF
)"
```

## 手测

自动化不能弹出真实微信订阅窗。上传体验版后用两个微信核对：

1. 甲点拒绝，乙已允许：只有乙收到下一条。
2. 乙收到一条后，再次产生工单时乙不再收到，直到乙再点允许。
3. 乙点停止接收后立即不再收到；两边都能在「客服工单」看到该工单。
4. 升级前已登录、但没有按新规则重新允许的微信不再收到。
