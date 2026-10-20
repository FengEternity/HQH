# 运营新工单企业微信通知 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 运营在企业微信授权一次后，用开关持续接收新工单；所有开着的人同时收到私人消息和群里的 @，同一工单只有先接手的人能回复和关闭。

**Architecture:** `wecomClient.js` 只负责企业微信 HTTP。`wecomDelivery.js` 按工单上的两路结果决定是否发送。`csStore.js` 保存绑定、开关和接手。小程序工单列表改开关，工单页增加接手。现有规则回复文案保持不变，只把 `notifyAdmins` 改为也会通知。

**Tech Stack:** 微信云开发 `wx-server-sdk`、云数据库、企业微信自建应用与群机器人、原生小程序、`node --test`。

## Global Constraints

- 规格：`docs/superpowers/specs/2026-10-20-wecom-admin-notify-design.md`。
- 在当前分支 `dev-wecom-admin-notify` 上实现。不要在 `main` 上 commit。
- Commit message 使用简体中文，不写 `DES-*` / `ANAL-*`。
- 不调用真实企业微信。测试注入假的 `fetch`。
- 企业 ID、应用 Secret、群机器人地址只从环境变量读取，不写入仓库，不写进日志。`session_key` 不落库、不返回给小程序。
- 不申请微信长期订阅，不调用 `wx.requestSubscribeMessage` 和 `csRegisterNotify`。
- 登录页不弹订阅窗，也不登记接收人。
- 不改领取账号、怎么找视频的回复文案和状态。
- 不把运营 PIN 改成独立账号。回复气泡不署名，页面不展示接手人姓名或 OpenID。
- 通知失败不回滚工单。用户侧「客服已回复」订阅维持现状。
- 个人开关同时决定私人消息和群里是否 @ 这个人。没人开启时两路都不发，也不写工单通知结果。
- 有效接手是 `replyClaimOpenid` 非空，且距离 `replyClaimAt` 不到 10 分钟。身份用小程序 OpenID。
- 有效接手期内，只有接手人能回复和关闭。



## 文件地图


| 路径                                                   | 职责                                    |
| ---------------------------------------------------- | ------------------------------------- |
| `cloudfunctions/ticketing/lib/wecomClient.js`        | `access_token`、code2Session、应用消息、群机器人 |
| `cloudfunctions/ticketing/lib/wecomClient.test.js`   | 上述 HTTP 行为                            |
| `cloudfunctions/ticketing/lib/wecomDelivery.js`      | 选出接收人，抢占并写下两路结果                       |
| `cloudfunctions/ticketing/lib/wecomDelivery.test.js` | 没人开启、部分失败、并发和补发                       |
| `cloudfunctions/ticketing/lib/csSendFlow.js`         | 规则回复也请求通知                             |
| `cloudfunctions/ticketing/lib/csStore.js`            | 绑定、开关、接手、回复和关闭守卫                      |
| `cloudfunctions/ticketing/lib/csStore.test.js`       | 绑定、开关、接手                              |
| `cloudfunctions/ticketing/index.js`                  | 新 action 与企业微信发送入口                    |
| `miniprogram/pages/admin/inbox/inbox.js`             | 开关状态和绑定                               |
| `miniprogram/pages/admin/inbox/inbox.wxml`           | 开关文案                                  |
| `miniprogram/pages/admin/inbox/inbox.test.js`        | 不走一次性订阅                               |
| `miniprogram/pages/admin/ticket/ticket.js`           | 接手、放开、回复守卫                            |
| `miniprogram/pages/admin/ticket/ticket.wxml`         | 接手按钮和提示                               |
| `miniprogram/pages/admin/ticket/ticket.test.js`      | 三种接手状态                                |


---



### Task 1: 企业微信 HTTP 客户端

**Files:**

- Create: `cloudfunctions/ticketing/lib/wecomClient.js`
- Create: `cloudfunctions/ticketing/lib/wecomClient.test.js`
- Test: `cloudfunctions/ticketing/lib/wecomClient.test.js`

**Interfaces:**

- Consumes: 注入的 `fetchImpl(url, { method, body })`，返回 `{ ok, status, json }`
- Produces:
  - `createWecomClient({ fetchImpl, env, now })`
  - `client.exchangeCode(code)` → `{ corpid, userid }`
  - `client.sendPersonal({ userIds, appId, page, now })` → 企业微信返回体
  - `client.sendGroup({ webhookUrl, userIds, now })` → 企业微信返回体
  - `access_token` 遇到 `40014` 或 `42001` 时刷新一次并重试当前请求

- [ ] **Step 1: 写失败测试**

`cloudfunctions/ticketing/lib/wecomClient.test.js`：

```js
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createWecomClient } = require('./wecomClient');

const env = {
  WECOM_CORP_ID: 'corp-1',
  WECOM_AGENT_ID: '1001',
  WECOM_AGENT_SECRET: 'secret-1',
};

function fakeFetch(routes) {
  const calls = [];
  return {
    calls,
    async fetchImpl(url, options = {}) {
      calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
      const route = routes.find((item) => url.includes(item.match));
      return { ok: true, status: 200, json: route ? route.json : { errcode: 0 } };
    },
  };
}

test('code 换成 userid', async () => {
  const http = fakeFetch([
    { match: 'gettoken', json: { errcode: 0, access_token: 'token-1', expires_in: 7200 } },
    { match: 'jscode2session', json: { errcode: 0, corpid: 'corp-1', userid: 'zhangsan', session_key: 'hidden' } },
  ]);
  const client = createWecomClient({ fetchImpl: http.fetchImpl, env, now: () => 1 });
  const result = await client.exchangeCode('login-code');
  assert.deepEqual(result, { corpid: 'corp-1', userid: 'zhangsan' });
  assert.equal(JSON.stringify(http.calls).includes('hidden'), false);
});

test('个人消息走应用，群消息走机器人', async () => {
  const http = fakeFetch([
    { match: 'gettoken', json: { errcode: 0, access_token: 'token-1', expires_in: 7200 } },
    { match: 'message/send', json: { errcode: 0, invaliduser: '' } },
    { match: 'webhook', json: { errcode: 0 } },
  ]);
  const client = createWecomClient({ fetchImpl: http.fetchImpl, env, now: () => 1_700_000_000_000 });
  await client.sendPersonal({
    userIds: ['zhangsan', 'lisi'],
    appId: 'wx-app',
    page: 'pages/admin/ticket/ticket?id=thread-1',
    now: 1_700_000_000_000,
  });
  await client.sendGroup({
    webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=demo',
    userIds: ['zhangsan', 'lisi'],
    now: 1_700_000_000_000,
  });
  const personal = http.calls.find((call) => call.url.includes('message/send'));
  const group = http.calls.find((call) => call.url.includes('webhook'));
  assert.equal(personal.body.touser, 'zhangsan|lisi');
  assert.equal(personal.body.msgtype, 'miniprogram_notice');
  assert.equal(personal.body.miniprogram_notice.page, 'pages/admin/ticket/ticket?id=thread-1');
  assert.deepEqual(group.body.text.mentioned_list, ['zhangsan', 'lisi']);
  assert.equal(group.body.text.content.includes('新工单'), true);
});

test('access_token 过期时刷新一次', async () => {
  let tokenCalls = 0;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push(url);
    if (url.includes('gettoken')) {
      tokenCalls += 1;
      return { ok: true, status: 200, json: { errcode: 0, access_token: 'token-' + tokenCalls, expires_in: 7200 } };
    }
    const body = JSON.parse(options.body);
    if (url.includes('message/send') && calls.filter((item) => item.includes('message/send')).length === 1) {
      return { ok: true, status: 200, json: { errcode: 42001, errmsg: 'expired' } };
    }
    assert.equal(body.agentid, 1001);
    return { ok: true, status: 200, json: { errcode: 0 } };
  };
  const client = createWecomClient({ fetchImpl, env, now: () => 1 });
  const result = await client.sendPersonal({
    userIds: ['zhangsan'],
    appId: 'wx-app',
    page: 'pages/admin/ticket/ticket?id=thread-1',
    now: 1,
  });
  assert.equal(result.errcode, 0);
  assert.equal(tokenCalls, 2);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test cloudfunctions/ticketing/lib/wecomClient.test.js`

Expected: FAIL，找不到 `./wecomClient`。

- [ ] **Step 3: 写最小实现**

`wecomClient.js` 提供 `createWecomClient`。`gettoken` 使用 `WECOM_CORP_ID` 和 `WECOM_AGENT_SECRET`。`exchangeCode` 调用 `miniprogram/jscode2session`，只返回 `corpid` 和 `userid`。`sendPersonal` 发送 `miniprogram_notice`，标题「新工单」，内容项为状态「待处理」和时间。`sendGroup` 发送文本，正文包含「新工单」「待处理」和时间，`mentioned_list` 等于 `userIds`。请求返回 `40014` 或 `42001` 时丢弃缓存 token，重新取一次并重试该请求一次。不要记录 secret、webhook 和 `session_key`。

- [ ] **Step 4: 运行测试并确认通过**

Run: `node --test cloudfunctions/ticketing/lib/wecomClient.test.js`

Expected: PASS，3 个测试。

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/ticketing/lib/wecomClient.js cloudfunctions/ticketing/lib/wecomClient.test.js
git commit -m "$(cat <<'EOF'
feat(cs): 增加企业微信通知客户端

EOF
)"
```

---



### Task 2: 绑定与开关

**Files:**

- Modify: `cloudfunctions/ticketing/lib/csStore.js`
- Modify: `cloudfunctions/ticketing/lib/csStore.test.js`
- Modify: `cloudfunctions/ticketing/index.js`
- Test: `cloudfunctions/ticketing/lib/csStore.test.js`

**Interfaces:**

- Consumes: `findSubscriber`、`codedError`
- Produces:
  - `csBindWecom(db, { openid, code, now, exchangeCode })` → `{ ok: true, bound: true, enabled: true }`
  - `csSetNotify(db, { openid, enabled, now })` → `{ ok: true, bound, enabled }`
  - `readWecomNotifyStatus(db, { openid })` → `{ bound: boolean, enabled: boolean }`
  - 不修改现有 `readNotifyStatus` 的 `{ enabled, quota }` 返回值。`csNotifyConfig` 改走 `readWecomNotifyStatus`。
  - 失败码：`BAD_INPUT`、`BIND_FAILED`、`UNBOUND`

- [ ] **Step 1: 写失败测试**

在 `csStore.test.js` 增加：

```js
test('绑定成功写入 userid 并开启', async () => {
  const db = makeMemoryDb();
  const result = await csBindWecom(db, {
    openid: 'wx-1',
    code: 'code-1',
    now: 10,
    exchangeCode: async () => ({ corpid: 'corp-1', userid: 'zhangsan' }),
  });
  assert.deepEqual(result, { ok: true, bound: true, enabled: true });
  assert.equal((await readWecomNotifyStatus(db, { openid: 'wx-1' })).bound, true);
});

test('企业不一致或空 OpenID 不写库', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    () => csBindWecom(db, {
      openid: 'wx-1',
      code: 'code-1',
      now: 10,
      exchangeCode: async () => ({ corpid: 'other', userid: 'zhangsan' }),
      expectedCorpId: 'corp-1',
    }),
    (error) => error.code === 'BIND_FAILED',
  );
  await assert.rejects(
    () => csBindWecom(db, { openid: '', code: 'code-1', now: 10, exchangeCode: async () => ({}) }),
    (error) => error.code === 'BAD_INPUT',
  );
  assert.equal(await findSubscriberCount(db, 'wx-1'), 0);
});

test('未绑定不能打开，关闭后保留 userid', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    () => csSetNotify(db, { openid: 'wx-1', enabled: true, now: 1 }),
    (error) => error.code === 'UNBOUND',
  );
  await csBindWecom(db, {
    openid: 'wx-1',
    code: 'code-1',
    now: 2,
    exchangeCode: async () => ({ corpid: 'corp-1', userid: 'zhangsan' }),
    expectedCorpId: 'corp-1',
  });
  const stopped = await csSetNotify(db, { openid: 'wx-1', enabled: false, now: 3 });
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.bound, true);
});
```

`findSubscriberCount` 直接读内存库里 `admin_notify_subscribers` 中该 `openid` 的条数。若现有测试库没有导出查询，在测试文件内用 `db.collection('admin_notify_subscribers').where({ openid }).get()`。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test cloudfunctions/ticketing/lib/csStore.test.js`

Expected: FAIL，`csBindWecom is not a function`。

- [ ] **Step 3: 写最小实现**

`csBindWecom`：空 `openid` 抛 `BAD_INPUT` 且不写库。空 `code` 在调用 `exchangeCode` 之前抛 `BIND_FAILED` 且不写库。换码后没有 `userid`，或 `corpid` 不等于 `expectedCorpId`，抛 `BIND_FAILED` 且不写库。成功时按 `openid` 写入或更新 `wecomUserId`、`boundAt`、`enabled: true`、`updatedAt`。不保存 `session_key`。

`csSetNotify`：空 `openid` 抛 `BAD_INPUT`。`enabled === true` 且没有 `wecomUserId` 时抛 `UNBOUND`。`enabled === false` 且没有记录时返回 `{ ok: true, bound: false, enabled: false }`。关闭时只改 `enabled`。

新增 `readWecomNotifyStatus`。`bound` 表示 `wecomUserId` 非空。没有记录时 `bound` 和 `enabled` 都是 false。不要改现有 `readNotifyStatus`。

`index.js` 顶部创建客户端：

```js
const { createWecomClient } = require('./lib/wecomClient');

const wecomClient = createWecomClient({
  fetchImpl: async (url, options = {}) => {
    const response = await fetch(url, options);
    return { ok: response.ok, status: response.status, json: await response.json() };
  },
  env: process.env,
  now: () => Date.now(),
});
```

`index.js` 增加：

```js
case 'csBindWecom':
  requireAdmin(event.ticket);
  return csBindWecom(db, {
    openid,
    code: event.code,
    now,
    expectedCorpId: process.env.WECOM_CORP_ID || '',
    exchangeCode: (code) => wecomClient.exchangeCode(code),
  });
case 'csSetNotify':
  requireAdmin(event.ticket);
  return csSetNotify(db, { openid, enabled: event.enabled === true, now });
case 'csNotifyConfig':
  requireAdmin(event.ticket);
  return Object.assign({ ok: true }, await readWecomNotifyStatus(db, { openid }));
```

`ERROR_MESSAGES` 增加 `BIND_FAILED: '绑定失败'`、`UNBOUND: '请先绑定企业微信'`。

- [ ] **Step 4: 运行测试并确认通过**

Run: `node --test cloudfunctions/ticketing/lib/csStore.test.js`

Expected: PASS。原有 `readNotifyStatus` 断言保持 `{ enabled, quota }`。

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/ticketing/lib/csStore.js cloudfunctions/ticketing/lib/csStore.test.js cloudfunctions/ticketing/index.js
git commit -m "$(cat <<'EOF'
feat(cs): 用企业微信成员绑定新工单开关

EOF
)"
```

---



### Task 3: 规则回复也请求通知

**Files:**

- Modify: `cloudfunctions/ticketing/lib/csSendFlow.js`
- Modify: `cloudfunctions/ticketing/lib/csSendFlow.test.js`
- Test: `cloudfunctions/ticketing/lib/csSendFlow.test.js`

**Interfaces:**

- Consumes: `planSend`
- Produces: 领取账号、怎么找视频、待人工和人工处理的 `notifyAdmins === true`。回复文案、`nextStatus` 和消息角色不变。

- [ ] **Step 1: 改失败测试**

把 `keeps open and replies for claim/howto without notifying admins` 改成：

```js
it('keeps open and replies for claim/howto while notifying admins', () => {
  const claim = planSend({
    status: 'open',
    text: '领取账号',
    faqId: 'claim',
    account: 'YD1',
    hasEscalateSystem: false,
  });
  assert.equal(claim.nextStatus, 'open');
  assert.equal(claim.notifyAdmins, true);
  assert.equal(claim.messages[1].text.includes('资料馆账号'), true);

  const howto = planSend({ status: 'open', text: '怎么找视频', faqId: 'howto', hasEscalateSystem: false });
  assert.equal(howto.nextStatus, 'open');
  assert.equal(howto.notifyAdmins, true);
  assert.equal(howto.messages[1].meta.source, 'rule');
});
```

待人工后续消息的现有断言 `notifyAdmins === true` 保持不变。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test cloudfunctions/ticketing/lib/csSendFlow.test.js`

Expected: FAIL，`claim.notifyAdmins` 仍是 false。

- [ ] **Step 3: 写最小实现**

两条规则回复的返回值把 `notifyAdmins` 设为 true。不要改 `assistant.text`、`meta` 和 `nextStatus`。

- [ ] **Step 4: 运行测试并确认通过**

Run: `node --test cloudfunctions/ticketing/lib/csSendFlow.test.js`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/ticketing/lib/csSendFlow.js cloudfunctions/ticketing/lib/csSendFlow.test.js
git commit -m "$(cat <<'EOF'
feat(cs): 规则回复也请求新工单通知

EOF
)"
```

---



### Task 4: 按工单发送两路通知

**Files:**

- Create: `cloudfunctions/ticketing/lib/wecomDelivery.js`
- Create: `cloudfunctions/ticketing/lib/wecomDelivery.test.js`
- Modify: `cloudfunctions/ticketing/index.js`
- Test: `cloudfunctions/ticketing/lib/wecomDelivery.test.js`

**Interfaces:**

- Consumes: `createWecomClient`、`admin_notify_subscribers`、`cs_threads`
- Produces:
  - `deliverWecomAdminNotifications(db, { threadId, now, page, env, client })`
  - 返回 `{ ok: true, group, personal }`，值为 `sent`、`skipped`、`failed` 或 `pending`
  - 工单字段：`adminNotifyClaimedAt`、`adminNotifyGroupAt`、`adminNotifyGroupResult`、`adminNotifyPersonalAt`、`adminNotifyPersonalResult`

- [ ] **Step 1: 写失败测试**

```js
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { deliverWecomAdminNotifications } = require('./wecomDelivery');

const TEN_MINUTES = 10 * 60 * 1000;

function seed(db, docs) {
  return Promise.all(docs.map((data) => db.collection('admin_notify_subscribers').add({ data })));
}

test('没人开启时不发送，也不写工单通知结果', async () => {
  const db = makeMemoryDb();
  await db.collection('cs_threads').add({ data: { _id: 'thread-1', status: 'open' } });
  const sends = [];
  const result = await deliverWecomAdminNotifications(db, {
    threadId: 'thread-1',
    now: 100,
    page: 'pages/admin/ticket/ticket?id=thread-1',
    env: { WECOM_GROUP_WEBHOOK: 'https://example.test/webhook', WECOM_MINI_APPID: 'wx-app' },
    client: {
      sendPersonal: async (payload) => sends.push(['personal', payload]),
      sendGroup: async (payload) => sends.push(['group', payload]),
    },
  });
  assert.deepEqual(sends, []);
  assert.equal(result.group, 'pending');
  const thread = (await db.collection('cs_threads').doc('thread-1').get()).data;
  assert.equal(thread.adminNotifyGroupAt, undefined);
});

test('有人开启时群只 @ 这些人，个人发给同一些人', async () => {
  const db = makeMemoryDb();
  await db.collection('cs_threads').add({ data: { _id: 'thread-1' } });
  await seed(db, [
    { openid: 'a', enabled: true, wecomUserId: 'zhangsan' },
    { openid: 'b', enabled: false, wecomUserId: 'lisi' },
    { openid: 'c', enabled: true, wecomUserId: '' },
  ]);
  const seen = [];
  await deliverWecomAdminNotifications(db, {
    threadId: 'thread-1',
    now: 100,
    page: 'pages/admin/ticket/ticket?id=thread-1',
    env: { WECOM_GROUP_WEBHOOK: 'https://example.test/webhook', WECOM_MINI_APPID: 'wx-app' },
    client: {
      sendPersonal: async (payload) => seen.push(payload.userIds),
      sendGroup: async (payload) => seen.push(payload.userIds),
    },
  });
  assert.deepEqual(seen, [['zhangsan'], ['zhangsan']]);
});

test('群成功、个人失败时下一次只补发个人', async () => {
  const db = makeMemoryDb();
  await db.collection('cs_threads').add({ data: { _id: 'thread-1' } });
  await seed(db, [{ openid: 'a', enabled: true, wecomUserId: 'zhangsan' }]);
  const env = { WECOM_GROUP_WEBHOOK: 'https://example.test/webhook', WECOM_MINI_APPID: 'wx-app' };
  await deliverWecomAdminNotifications(db, {
    threadId: 'thread-1',
    now: 100,
    page: 'pages/admin/ticket/ticket?id=thread-1',
    env,
    client: {
      sendGroup: async () => ({ errcode: 0 }),
      sendPersonal: async () => { throw new Error('down'); },
    },
  });
  const second = [];
  await deliverWecomAdminNotifications(db, {
    threadId: 'thread-1',
    now: 200,
    page: 'pages/admin/ticket/ticket?id=thread-1',
    env,
    client: {
      sendGroup: async () => second.push('group'),
      sendPersonal: async () => {
        second.push('personal');
        return { errcode: 0 };
      },
    },
  });
  assert.deepEqual(second, ['personal']);
});

test('部分 invaliduser 仍算个人发送成功', async () => {
  const db = makeMemoryDb();
  await db.collection('cs_threads').add({ data: { _id: 'thread-1' } });
  await seed(db, [{ openid: 'a', enabled: true, wecomUserId: 'zhangsan' }]);
  await deliverWecomAdminNotifications(db, {
    threadId: 'thread-1',
    now: 100,
    page: 'pages/admin/ticket/ticket?id=thread-1',
    env: { WECOM_GROUP_WEBHOOK: '', WECOM_MINI_APPID: 'wx-app' },
    client: {
      sendPersonal: async () => ({ errcode: 0, invaliduser: 'missing' }),
      sendGroup: async () => { throw new Error('should not send'); },
    },
  });
  const thread = (await db.collection('cs_threads').doc('thread-1').get()).data;
  assert.equal(thread.adminNotifyGroupResult, 'skipped');
  assert.equal(thread.adminNotifyPersonalResult, 'sent');
});
```

测试文件自己包含一份内存数据库，条件更新在 `stats.updated` 返回 0 或 1。不要从生产模块导出测试库。再加这两个测试：

```js
test('两路都失败后可以整轮再试', async () => {
  const db = makeMemoryDb();
  await db.collection('cs_threads').add({ data: { _id: 'thread-1' } });
  await seed(db, [{ openid: 'a', enabled: true, wecomUserId: 'zhangsan' }]);
  const env = { WECOM_GROUP_WEBHOOK: 'https://example.test/webhook', WECOM_MINI_APPID: 'wx-app' };
  const input = {
    threadId: 'thread-1',
    now: 100,
    page: 'pages/admin/ticket/ticket?id=thread-1',
    env,
    client: {
      sendGroup: async () => { throw new Error('group down'); },
      sendPersonal: async () => { throw new Error('personal down'); },
    },
  };
  await deliverWecomAdminNotifications(db, input);
  const thread = (await db.collection('cs_threads').doc('thread-1').get()).data;
  assert.equal(thread.adminNotifyClaimedAt, undefined);
  const seen = [];
  await deliverWecomAdminNotifications(db, Object.assign({}, input, {
    now: 300,
    client: {
      sendGroup: async () => { seen.push('group'); return { errcode: 0 }; },
      sendPersonal: async () => { seen.push('personal'); return { errcode: 0 }; },
    },
  }));
  assert.deepEqual(seen.sort(), ['group', 'personal']);
});

test('120 秒内第二个调用不再发送', async () => {
  const db = makeMemoryDb({ holdNotifyClaim: true });
  await db.collection('cs_threads').add({
    data: { _id: 'thread-1', adminNotifyClaimedAt: 100 },
  });
  await seed(db, [{ openid: 'a', enabled: true, wecomUserId: 'zhangsan' }]);
  const seen = [];
  await deliverWecomAdminNotifications(db, {
    threadId: 'thread-1',
    now: 100 + 119000,
    page: 'pages/admin/ticket/ticket?id=thread-1',
    env: { WECOM_GROUP_WEBHOOK: 'https://example.test/webhook', WECOM_MINI_APPID: 'wx-app' },
    client: {
      sendGroup: async () => seen.push('group'),
      sendPersonal: async () => seen.push('personal'),
    },
  });
  assert.deepEqual(seen, []);
});
```

`holdNotifyClaim: true` 表示内存库里已有未过期的 `adminNotifyClaimedAt` 时，条件更新返回 `updated: 0`。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test cloudfunctions/ticketing/lib/wecomDelivery.test.js`

Expected: FAIL，找不到模块。

- [ ] **Step 3: 写最小实现**

接收人查询 `enabled === true` 且 `wecomUserId` 非空。没有接收人时返回两路 `pending`，不写工单。

有接收人时，条件更新 `adminNotifyClaimedAt`：字段不存在，或早于 `now - 120000`，才能写上 `now`。没抢到就直接返回，不发送。

群地址为空：写 `adminNotifyGroupResult: 'skipped'` 和 `adminNotifyGroupAt`。群 `errcode === 0` 写 `sent`。其他结果不写群字段。

个人 `errcode === 0` 写 `sent`，即使 `invaliduser` 非空。`81013`、抛错或其他非 0 不写个人字段。

本次调用结束后清掉 `adminNotifyClaimedAt`。两路都已有结果时，后续调用不再发送。

`index.js` 的 `notifyAdmins(now, thread)` 改为调用 `deliverWecomAdminNotifications`。`page` 使用 `pages/admin/ticket/ticket?id=` 加上线程 ID。环境变量读取 `WECOM_GROUP_WEBHOOK` 和 `WECOM_MINI_APPID`。`csSend` 已经把线程传给 `notifyAdminsFn`，入口改成把 `thread._id` 传下去。

- [ ] **Step 4: 运行测试并确认通过**

Run: `node --test cloudfunctions/ticketing/lib/wecomDelivery.test.js cloudfunctions/ticketing/lib/csStore.test.js`

Expected: PASS。`csStore` 里「通知函数抛错时工单和消息仍在」继续通过。

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/ticketing/lib/wecomDelivery.js cloudfunctions/ticketing/lib/wecomDelivery.test.js cloudfunctions/ticketing/index.js
git commit -m "$(cat <<'EOF'
feat(cs): 新工单按开启名单发企业微信

EOF
)"
```

---



### Task 5: 客服工单页开关

**Files:**

- Modify: `miniprogram/pages/admin/inbox/inbox.js`
- Modify: `miniprogram/pages/admin/inbox/inbox.wxml`
- Modify: `miniprogram/pages/admin/inbox/inbox.test.js`
- Test: `miniprogram/pages/admin/inbox/inbox.test.js`

**Interfaces:**

- Consumes: `csNotifyConfig`、`csBindWecom`、`csSetNotify`
- Produces: `notifyLabelText(bound, enabled)` 返回 `未绑定`、`未开启` 或 `接收中`

- [ ] **Step 1: 写失败测试**

替换订阅相关用例，保留「通知区在筛选上面」：

```js
it('does not subscribe when this WeChat is outside WeCom', async () => {
  const events = [];
  global.wx = {
    requestSubscribeMessage() {
      events.push('subscribe');
    },
    showToast({ title }) {
      events.push(title);
    },
  };
  const page = loadPage({
    ticketingAdmin: async (data) => {
      events.push(data.action);
      if (data.action === 'csNotifyConfig') {
        return { ok: true, bound: false, enabled: false };
      }
      return { ok: true, threads: [] };
    },
  });
  await page.onShow();
  await page.toggleNotify({ detail: { value: true } });
  assert.equal(events.includes('subscribe'), false);
  assert.equal(events.includes('csBindWecom'), false);
  assert.equal(events.includes('请在企业微信中打开后再开启'), true);
});

it('binds inside WeCom and shows 接收中', async () => {
  const events = [];
  global.wx = {
    qy: { login: () => Promise.resolve({ code: 'code-1' }) },
    showToast({ title }) { events.push(title); },
  };
  const page = loadPage({
    ticketingAdmin: async (data) => {
      events.push(data.action);
      if (data.action === 'csBindWecom') {
        assert.equal(data.code, 'code-1');
        return { ok: true, bound: true, enabled: true };
      }
      return { ok: true, bound: false, enabled: false, threads: [] };
    },
  });
  await page.onShow();
  await page.toggleNotify({ detail: { value: true } });
  assert.equal(page.data.notifyLabel, '接收中');
  assert.equal(events.includes('已开启'), true);
});

it('toggles an existing binding without logging in again', async () => {
  const actions = [];
  global.wx = { qy: { login() { throw new Error('should not login'); } }, showToast() {} };
  const page = loadPage({
    ticketingAdmin: async (data) => {
      actions.push(data.action);
      if (data.action === 'csNotifyConfig') return { ok: true, bound: true, enabled: false };
      if (data.action === 'csSetNotify') return { ok: true, bound: true, enabled: data.enabled };
      return { ok: true, threads: [] };
    },
  });
  await page.onShow();
  await page.toggleNotify({ detail: { value: true } });
  await page.toggleNotify({ detail: { value: false } });
  assert.deepEqual(actions.filter((item) => item === 'csSetNotify'), ['csSetNotify', 'csSetNotify']);
  assert.equal(page.data.notifyLabel, '未开启');
});
```

再断言停止失败时 `notifyLabel` 仍是 `接收中`，以及 wxml 不再包含 `requestSubscribeMessage` 的绑定和 `csRegisterNotify`。说明文案是「开启后，新工单会发到你的企业微信，并在运营群 @ 你。停止后这两处都不再通知你。」

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test miniprogram/pages/admin/inbox/inbox.test.js`

Expected: FAIL，`toggleNotify` 不存在。

- [ ] **Step 3: 写最小实现**

`notifyLabelText(bound, enabled)` 按未绑定、未开启、接收中返回。`loadNotifyTemplate` 使用 `result.bound` 和 `result.enabled`。`toggleNotify` 在未绑定且没有 `wx.qy.login` 时 toast「请在企业微信中打开后再开启」。有 `wx.qy.login` 时取 `code` 调 `csBindWecom`。已绑定时只调 `csSetNotify`。失败 toast「绑定失败」或「停止失败」，不改动失败前的标签。

wxml 用 `switch`，`checked="{{notifyEnabled}}"`，`bindchange="toggleNotify"`。删除 `bindNotify` 和「停止接收」按钮。

- [ ] **Step 4: 运行测试并确认通过**

Run: `node --test miniprogram/pages/admin/inbox/inbox.test.js`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add miniprogram/pages/admin/inbox/inbox.js miniprogram/pages/admin/inbox/inbox.wxml miniprogram/pages/admin/inbox/inbox.test.js
git commit -m "$(cat <<'EOF'
feat(cs): 工单页改用企业微信通知开关

EOF
)"
```

---



### Task 6: 接手后才能回复和关闭

**Files:**

- Modify: `cloudfunctions/ticketing/lib/csStore.js`
- Modify: `cloudfunctions/ticketing/lib/csStore.test.js`
- Modify: `cloudfunctions/ticketing/index.js`
- Test: `cloudfunctions/ticketing/lib/csStore.test.js`

**Interfaces:**

- Consumes: `getThread`、`csAdminReply`、`csAdminClose`
- Produces:
  - `csClaimReply(db, { threadId, openid, now })` → `{ ok: true, thread }`
  - `csReleaseReply(db, { threadId, openid, now })` → `{ ok: true, thread }`
  - `csAdminReply` 和 `csAdminClose` 增加必填 `openid`
  - 错误码 `CLAIMED`、`CLAIM_REQUIRED`
  - `CLAIM_WINDOW_MS = 600000`

- [ ] **Step 1: 写失败测试**

```js
test('两人同时接手只有一人成功', async () => {
  const db = makeMemoryDb();
  const thread = await createWaitingThread(db);
  const results = await Promise.allSettled([
    csClaimReply(db, { threadId: thread._id, openid: 'wx-a', now: 1_000 }),
    csClaimReply(db, { threadId: thread._id, openid: 'wx-b', now: 1_000 }),
  ]);
  const ok = results.filter((item) => item.status === 'fulfilled');
  assert.equal(ok.length, 1);
});

test('未接手不能回复和关闭', async () => {
  const db = makeMemoryDb();
  const thread = await createWaitingThread(db);
  await assert.rejects(
    () => csAdminReply(db, { threadId: thread._id, openid: 'wx-a', text: '收到', now: 1_000 }),
    (error) => error.code === 'CLAIM_REQUIRED',
  );
  await assert.rejects(
    () => csAdminClose(db, { threadId: thread._id, openid: 'wx-a', now: 1_000 }),
    (error) => error.code === 'CLAIM_REQUIRED',
  );
  assert.equal((await csAdminGet(db, { threadId: thread._id })).thread.status, 'waiting_human');
});

test('回复后 10 分钟重新计算，超时后别人可以接手', async () => {
  const db = makeMemoryDb();
  const thread = await createWaitingThread(db);
  await csClaimReply(db, { threadId: thread._id, openid: 'wx-a', now: 1_000 });
  await csAdminReply(db, { threadId: thread._id, openid: 'wx-a', text: '收到', now: 2_000 });
  await assert.rejects(
    () => csClaimReply(db, { threadId: thread._id, openid: 'wx-b', now: 2_000 + 599999 }),
    (error) => error.code === 'CLAIMED',
  );
  const taken = await csClaimReply(db, {
    threadId: thread._id,
    openid: 'wx-b',
    now: 2_000 + 600000,
  });
  assert.equal(taken.thread.replyClaimOpenid, 'wx-b');
});

test('放开和关闭都会清掉接手', async () => {
  const db = makeMemoryDb();
  const thread = await createWaitingThread(db);
  await csClaimReply(db, { threadId: thread._id, openid: 'wx-a', now: 1_000 });
  await csReleaseReply(db, { threadId: thread._id, openid: 'wx-a', now: 1_100 });
  await csClaimReply(db, { threadId: thread._id, openid: 'wx-b', now: 1_200 });
  const closed = await csAdminClose(db, { threadId: thread._id, openid: 'wx-b', now: 1_300 });
  assert.equal(closed.thread.status, 'closed');
  assert.equal(closed.thread.replyClaimOpenid, '');
});
```

`createWaitingThread` 在测试里插入一条 `waiting_human` 工单。内存库的条件更新必须只让一个并发 `csClaimReply` 成功；现有 `makeMemoryDb` 若没有比较写入，给工单更新增加「仅当接手为空或已过期」的条件。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test cloudfunctions/ticketing/lib/csStore.test.js`

Expected: FAIL，`csClaimReply is not a function`。

- [ ] **Step 3: 写最小实现**

有效接手判断：`replyClaimOpenid` 非空且 `now - replyClaimAt < 600000`。

`csClaimReply` 用条件更新。当前没有有效接手，或有效接手人就是该 OpenID 时写入。别人持有时抛 `CLAIMED`。

`csReleaseReply` 只有当前有效接手人能把两个字段写空。别人抛 `CLAIMED`。已经失效时返回成功。

`csAdminReply` 和 `csAdminClose` 在写入前检查当前 OpenID。不是有效接手人抛 `CLAIM_REQUIRED`。回复成功后更新 `replyClaimAt`。关闭成功后把 `replyClaimOpenid` 写为 `''`，`replyClaimAt` 写为 0。

`index.js` 把 `openid` 传给回复、关闭、接手和放开。增加 `CLAIMED: '已有同事正在处理'`、`CLAIM_REQUIRED: '需要先接手'`。

- [ ] **Step 4: 运行测试并确认通过**

Run: `node --test cloudfunctions/ticketing/lib/csStore.test.js`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add cloudfunctions/ticketing/lib/csStore.js cloudfunctions/ticketing/lib/csStore.test.js cloudfunctions/ticketing/index.js
git commit -m "$(cat <<'EOF'
feat(cs): 同一工单先接手才能回复

EOF
)"
```

---



### Task 7: 工单页显示接手状态

**Files:**

- Modify: `miniprogram/pages/admin/ticket/ticket.js`
- Modify: `miniprogram/pages/admin/ticket/ticket.wxml`
- Modify: `miniprogram/pages/admin/ticket/ticket.test.js`
- Test: `miniprogram/pages/admin/ticket/ticket.test.js`

**Interfaces:**

- Consumes: `csAdminGet` 返回的 `thread.replyClaimOpenid`、`thread.replyClaimAt`，以及 `csClaimReply`、`csReleaseReply`
- Produces: `claimState(thread, openid, now)` 返回 `none`、`mine` 或 `other`

服务端不把当前运营 OpenID 放进现有工单读取结果。`csAdminGet` 额外返回 `viewerOpenid`，值是 `cloud.getWXContext().OPENID`。页面用它和 `replyClaimOpenid`、`replyClaimAt` 计算状态。

- [ ] **Step 1: 写失败测试**

```js
it('不发送未接手的回复', async () => {
  const calls = [];
  const page = loadPage({
    ticketingAdmin: async (data) => {
      calls.push(data.action);
      return threadResult([], 'waiting_human', { viewerOpenid: 'wx-a' });
    },
  });
  page.setData({ threadId: 'thread-1', draft: '收到' });
  await page.onShow();
  await page.reply();
  assert.equal(calls.includes('csAdminReply'), false);
  assert.equal(page.data.claimState, 'none');
});

it('接手人可以回复并看到放开', async () => {
  const calls = [];
  const page = loadPage({
    ticketingAdmin: async (data) => {
      calls.push(data.action);
      return threadResult([], 'human', {
        viewerOpenid: 'wx-a',
        replyClaimOpenid: 'wx-a',
        replyClaimAt: Date.now(),
      });
    },
  });
  page.setData({ threadId: 'thread-1', draft: '收到' });
  await page.onShow();
  await page.reply();
  assert.equal(calls.includes('csAdminReply'), true);
  assert.equal(page.data.claimState, 'mine');
});

it('别人接手时不发送并提示正在处理', async () => {
  const calls = [];
  global.wx.showToast = ({ title }) => calls.push(title);
  const page = loadPage({
    ticketingAdmin: async () => threadResult([], 'waiting_human', {
      viewerOpenid: 'wx-b',
      replyClaimOpenid: 'wx-a',
      replyClaimAt: Date.now(),
    }),
  });
  page.setData({ threadId: 'thread-1', draft: '收到' });
  await page.onShow();
  await page.reply();
  assert.equal(page.data.claimState, 'other');
  assert.equal(calls.includes('已有同事正在处理'), true);
});
```

`threadResult` 增加第三个参数，把接手字段合并进 `thread`。wxml 断言：`claimState === 'none'` 时有「接手」，`mine` 时有「放开」，`other` 时有「已有同事正在处理」。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test miniprogram/pages/admin/ticket/ticket.test.js`

Expected: FAIL，`claimState` 为空。

- [ ] **Step 3: 写最小实现**

`claimState`：没有 `replyClaimOpenid`，或 `now - replyClaimAt >= 600000` 时返回 `none`。等于 `viewerOpenid` 返回 `mine`，否则返回 `other`。

`reply` 在 `none` 时 toast「需要先接手」并返回。在 `other` 时 toast「已有同事正在处理」并返回。只有 `mine` 调用 `csAdminReply`。

新增 `claim()` 调 `csClaimReply`，`release()` 调 `csReleaseReply`。成功后刷新工单。`CLAIMED` 用「已有同事正在处理」，放开失败用「放开失败」。

wxml 在输入框上方按 `claimState` 显示「接手」「放开」或「已有同事正在处理」。

`index.js` 的 `csAdminGet` 返回值加上 `viewerOpenid: openid`。

- [ ] **Step 4: 运行测试并确认通过**

Run: `node --test miniprogram/pages/admin/ticket/ticket.test.js cloudfunctions/ticketing/lib/csStore.test.js cloudfunctions/ticketing/lib/wecomDelivery.test.js cloudfunctions/ticketing/lib/wecomClient.test.js cloudfunctions/ticketing/lib/csSendFlow.test.js miniprogram/pages/admin/inbox/inbox.test.js`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add miniprogram/pages/admin/ticket/ticket.js miniprogram/pages/admin/ticket/ticket.wxml miniprogram/pages/admin/ticket/ticket.test.js cloudfunctions/ticketing/index.js
git commit -m "$(cat <<'EOF'
feat(cs): 工单页显示接手和放开

EOF
)"
```

