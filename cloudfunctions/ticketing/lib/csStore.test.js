'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
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
  deliverAdminNotifications,
} = require('./csStore');

function makeMemoryDb({
  failFirstConditionalUpdate = false,
  rejectOrderBy = false,
  failNotifySettleOnce = false,
} = {}) {
  const tables = new Map();
  let nextId = 1;
  let conditionalUpdateFailed = false;
  let notifySettleFailed = false;

  function rows(name) {
    if (!tables.has(name)) {
      tables.set(name, []);
    }
    return tables.get(name);
  }

  function subscriberOpenidTaken(openid) {
    return rows('admin_notify_subscribers').some((item) => item.openid === openid);
  }

  function duplicateOpenidError() {
    const error = new Error('同一微信已存在通知订阅记录');
    error.code = 'DUPLICATE_OPENID';
    return error;
  }

  function applyPatch(item, data) {
    Object.entries(data || {}).forEach(([key, value]) => {
      if (value && value.__op === 'inc') {
        item[key] = (Number(item[key]) || 0) + value.value;
        return;
      }
      item[key] = value;
    });
  }

  function matches(doc, where) {
    return Object.entries(where || {}).every(([key, expected]) => {
      if (expected && expected.__op === 'neq') {
        return doc[key] !== expected.value;
      }
      if (expected && expected.__op === 'gt') {
        return Number(doc[key]) > expected.value;
      }
      return doc[key] === expected;
    });
  }

  function query(name, where = {}, order, max, skipCount = 0) {
    return {
      where(extra) {
        return query(name, Object.assign({}, where, extra), order, max, skipCount);
      },
      orderBy(field, direction) {
        if (rejectOrderBy && Object.keys(where).length > 0) {
          const failed = {
            where() {
              return failed;
            },
            orderBy() {
              return failed;
            },
            limit() {
              return failed;
            },
            skip() {
              return failed;
            },
            async get() {
              const error = new Error('缺少组合索引');
              error.code = 'INDEX_REQUIRED';
              throw error;
            },
            async update() {
              const error = new Error('缺少组合索引');
              error.code = 'INDEX_REQUIRED';
              throw error;
            },
          };
          return failed;
        }
        return query(name, where, { field, direction }, max, skipCount);
      },
      limit(value) {
        return query(name, where, order, value, skipCount);
      },
      skip(value) {
        return query(name, where, order, max, value);
      },
      async get() {
        let data = rows(name).filter((item) => matches(item, where));
        if (order) {
          const sign = order.direction === 'desc' ? -1 : 1;
          data = data.slice().sort((a, b) => sign * (a[order.field] - b[order.field]));
        }
        if (skipCount) {
          data = data.slice(skipCount);
        }
        if (max !== undefined) {
          data = data.slice(0, max);
        }
        return { data: data.map((item) => Object.assign({}, item)) };
      },
      async update({ data }) {
        if (failFirstConditionalUpdate && !conditionalUpdateFailed && where.status) {
          conditionalUpdateFailed = true;
          const conflicted = rows(name).find((item) => matches(item, where));
          if (conflicted) {
            conflicted.status = 'waiting_human';
          }
          return { stats: { updated: 0 } };
        }
        let updated = 0;
        for (const item of rows(name)) {
          if (matches(item, where)) {
            applyPatch(item, data);
            updated += 1;
          }
        }
        return { stats: { updated } };
      },
    };
  }

  return {
    command: {
      neq(value) {
        return { __op: 'neq', value };
      },
      gt(value) {
        return { __op: 'gt', value };
      },
      inc(value) {
        return { __op: 'inc', value };
      },
    },
    collection(name) {
      return Object.assign(query(name), {
        async add({ data }) {
          if (name === 'admin_notify_subscribers' && data.openid && subscriberOpenidTaken(data.openid)) {
            throw duplicateOpenidError();
          }
          const _id = `id-${nextId++}`;
          rows(name).push(Object.assign({ _id }, data));
          return { _id };
        },
        doc(id) {
          return {
            async get() {
              const data = rows(name).find((item) => item._id === id);
              return { data: data ? Object.assign({}, data) : null };
            },
            async set({ data }) {
              if (name === 'admin_notify_subscribers') {
                const openid = data.openid || id;
                if (
                  rows(name).some((item) => item._id === id) ||
                  subscriberOpenidTaken(openid)
                ) {
                  throw duplicateOpenidError();
                }
              } else if (rows(name).some((item) => item._id === id)) {
                throw duplicateOpenidError();
              }
              rows(name).push(Object.assign({ _id: id }, data));
              return { stats: { updated: 1 } };
            },
            async update({ data }) {
              if (
                name === 'admin_notify_subscribers' &&
                failNotifySettleOnce &&
                !notifySettleFailed
              ) {
                notifySettleFailed = true;
                throw new Error('settle write failed');
              }
              const item = rows(name).find((entry) => entry._id === id);
              if (!item) {
                return { stats: { updated: 0 } };
              }
              applyPatch(item, data);
              return { stats: { updated: 1 } };
            },
          };
        },
      });
    },
  };
}

test('csHistory 重复读取只创建一条欢迎消息', async () => {
  const db = makeMemoryDb();

  const first = await csHistory(db, { openid: 'user-1', now: 100 });
  const second = await csHistory(db, { openid: 'user-1', now: 200 });

  assert.equal(second.thread._id, first.thread._id);
  assert.deepEqual(
    second.messages.map((message) => message.role),
    ['assistant'],
  );
  assert.equal(second.messages[0].meta.source, 'rule');
  assert.equal(second.messages[0].meta.actions.length, 3);
});

test('领取账号自动回复后默认待处理列表为空', async () => {
  const db = makeMemoryDb();

  await csSend(db, {
    openid: 'user-1',
    text: '领取账号',
    faqId: 'claim',
    account: 'demo-account',
    now: 200,
    notifyAdminsFn: async () => {},
  });

  const result = await csAdminList(db, { now: 300 });
  assert.deepEqual(result.threads, []);
});

test('自由输入升级为待处理并在通知失败时仍成功', async () => {
  const db = makeMemoryDb();

  const sent = await csSend(db, {
    openid: 'user-1',
    text: '这是一个具体问题',
    now: 200,
    notifyAdminsFn: async () => {
      throw new Error('send failed');
    },
  });
  const result = await csAdminList(db, { now: 300 });

  assert.equal(sent.ok, true);
  assert.equal(sent.thread.status, 'waiting_human');
  assert.equal(result.threads.length, 1);
  assert.equal(result.threads[0]._id, sent.thread._id);
});

test('运营回复后用户历史可见 operator 消息', async () => {
  const db = makeMemoryDb();
  const sent = await csSend(db, {
    openid: 'user-1',
    text: '请人工处理',
    now: 200,
    notifyAdminsFn: async () => {},
  });

  await csAdminReply(db, {
    threadId: sent.thread._id,
    text: '已经为你处理',
    now: 300,
    notifyUserFn: async () => {},
  });
  const history = await csHistory(db, { openid: 'user-1', now: 400 });

  assert.equal(history.thread.status, 'human');
  assert.equal(history.messages.at(-1).role, 'operator');
  assert.equal(history.messages.at(-1).text, '已经为你处理');
});

test('运营不能回复尚未升级的 open 线程', async () => {
  const db = makeMemoryDb();
  const history = await csHistory(db, { openid: 'user-1', now: 100 });

  await assert.rejects(
    csAdminReply(db, {
      threadId: history.thread._id,
      text: '错误回复',
      now: 200,
      notifyUserFn: async () => {},
    }),
    { code: 'INVALID_STATE' },
  );
});

test('关闭线程后用户再次发送会创建新线程', async () => {
  const db = makeMemoryDb();
  const first = await csSend(db, {
    openid: 'user-1',
    text: '请人工处理',
    now: 200,
    notifyAdminsFn: async () => {},
  });
  await csAdminClose(db, { threadId: first.thread._id, now: 300 });

  const second = await csSend(db, {
    openid: 'user-1',
    threadId: first.thread._id,
    text: '新的问题',
    now: 400,
    notifyAdminsFn: async () => {},
  });

  assert.notEqual(second.thread._id, first.thread._id);
  assert.equal(second.thread.status, 'waiting_human');
  assert.deepEqual(
    second.messages.map((message) => message.text),
    [
      '如您需求的问题没有解决，请联系我完善问题库，并领取账号。',
      '请人工处理',
      '已转交运营。请稍候，回复会出现在本页。',
      '如您需求的问题没有解决，请联系我完善问题库，并领取账号。',
      '新的问题',
      '已转交运营。请稍候，回复会出现在本页。',
    ],
  );
});

test('关闭线程后 csHistory 返回旧会话并创建新欢迎消息', async () => {
  const db = makeMemoryDb();
  const first = await csSend(db, {
    openid: 'user-1',
    text: '旧问题',
    now: 200,
    notifyAdminsFn: async () => {},
  });
  await csAdminClose(db, { threadId: first.thread._id, now: 300 });

  const history = await csHistory(db, { openid: 'user-1', now: 400 });

  assert.notEqual(history.thread._id, first.thread._id);
  assert.equal(history.thread.status, 'open');
  assert.deepEqual(
    history.messages.map((message) => message.text),
    [
      '如您需求的问题没有解决，请联系我完善问题库，并领取账号。',
      '旧问题',
      '已转交运营。请稍候，回复会出现在本页。',
      '如您需求的问题没有解决，请联系我完善问题库，并领取账号。',
    ],
  );
});

test('缓存的 threadId 已不存在时发送会创建新线程', async () => {
  const db = makeMemoryDb();

  const result = await csSend(db, {
    openid: 'user-1',
    threadId: 'missing-thread',
    text: '新的问题',
    now: 200,
    notifyAdminsFn: async () => {},
  });

  assert.equal(result.thread.status, 'waiting_human');
  assert.notEqual(result.thread._id, 'missing-thread');
});

test('状态条件更新首次冲突时重读并重试', async () => {
  const db = makeMemoryDb({ failFirstConditionalUpdate: true });

  const result = await csSend(db, {
    openid: 'user-1',
    text: '需要人工',
    now: 200,
    notifyAdminsFn: async () => {},
  });

  assert.equal(result.thread.status, 'waiting_human');
  assert.equal(
    result.messages.some((message) => message.meta && message.meta.event === 'escalated'),
    false,
  );
});

test('工单消息只返回最近 500 条并保持时间升序', async () => {
  const db = makeMemoryDb();
  const added = await db.collection('cs_threads').add({
    data: { openid: 'user-1', status: 'human', createdAt: 1, updatedAt: 1 },
  });
  for (let index = 1; index <= 510; index += 1) {
    await db.collection('cs_messages').add({
      data: {
        threadId: added._id,
        openid: 'user-1',
        role: 'user',
        text: String(index),
        createdAt: index,
      },
    });
  }

  const result = await csAdminGet(db, { threadId: added._id });

  assert.equal(result.messages.length, 500);
  assert.equal(result.messages[0].text, '11');
  assert.equal(result.messages.at(-1).text, '510');
});

test('自由输入在缺少组合索引时仍按更新时间出现在待处理列表', async () => {
  const db = makeMemoryDb({ rejectOrderBy: true });

  await csSend(db, {
    openid: 'user-1',
    text: '先发',
    now: 100,
    notifyAdminsFn: async () => {},
  });
  await csSend(db, {
    openid: 'user-2',
    text: '测试',
    now: 300,
    notifyAdminsFn: async () => {},
  });

  const result = await csAdminList(db, {});

  assert.deepEqual(
    result.threads.map((item) => item.preview),
    ['测试', '先发'],
  );
});

test('用户不能向其他 openid 的线程发送消息', async () => {
  const db = makeMemoryDb();
  const owner = await csHistory(db, { openid: 'owner', now: 100 });

  await assert.rejects(
    csSend(db, {
      openid: 'intruder',
      threadId: owner.thread._id,
      text: '越权消息',
      now: 200,
      notifyAdminsFn: async () => {},
    }),
    { code: 'FORBIDDEN', message: '无权访问该会话' },
  );
});

test('并发首次登记同一微信只保留一条记录且额度与库内一致', async () => {
  const db = makeMemoryDb();
  let releaseFirst;
  const gate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let gateEnteredResolve;
  const gateEntered = new Promise((resolve) => {
    gateEnteredResolve = resolve;
  });
  let firstPaused = false;
  db._awaitBeforeSubscriberAdd = async () => {
    if (!firstPaused) {
      firstPaused = true;
      gateEnteredResolve();
      await gate;
    }
  };

  const firstCall = csRegisterNotify(db, {
    openid: 'wx-race',
    templateId: 'tpl',
    now: 1,
  });
  await gateEntered;

  const second = await csRegisterNotify(db, {
    openid: 'wx-race',
    templateId: 'tpl',
    now: 2,
  });
  releaseFirst();
  const first = await firstCall;

  const stored = await db.collection('admin_notify_subscribers').where({ openid: 'wx-race' }).get();
  assert.equal(stored.data.length, 1);
  assert.equal(stored.data[0].quota, 2);
  assert.equal(second.quota, 1);
  assert.equal(first.quota, stored.data[0].quota);
  assert.deepEqual(await readNotifyStatus(db, { openid: 'wx-race' }), {
    enabled: true,
    quota: 2,
  });
});

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

test('发送成功但结算写入失败时仍计为已发送且不退回额度', async () => {
  const db = makeMemoryDb({ failNotifySettleOnce: true });
  await csRegisterNotify(db, { openid: 'wx-1', templateId: 'tpl', now: 1 });
  const result = await deliverAdminNotifications(db, {
    templateId: 'tpl',
    now: 2,
    page: 'pages/admin/inbox/inbox',
    send: async () => ({}),
  });

  assert.deepEqual(result, { ok: true, sent: 1, skipped: 0 });
  assert.equal((await readNotifyStatus(db, { openid: 'wx-1' })).quota, 0);
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

module.exports = { makeMemoryDb };
