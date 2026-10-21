'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  csAdminList,
  csAdminGet,
  csAdminReply,
  csAdminClose,
  csClaimReply,
  csReleaseReply,
  csHistory,
  csSend,
  csRegisterNotify,
  csUnregisterNotify,
  readNotifyStatus,
  readWecomNotifyStatus,
  csBindWecom,
  csBindProfile,
  csGetProfile,
  csSetNotify,
  listNotifyCandidates,
  reserveNotifySend,
  finishNotifySend,
  deliverAdminNotifications,
} = require('./csStore');

function makeMemoryDb({
  failFirstConditionalUpdate = false,
  rejectOrderBy = false,
  failNotifySettleOnce = false,
  afterFirstTransaction = null,
} = {}) {
  const tables = new Map();
  let nextId = 1;
  let conditionalUpdateFailed = false;
  let notifySettleFailed = false;
  let transactionTail = Promise.resolve();
  let firstTransactionPaused = false;

  function rows(name) {
    if (!tables.has(name)) {
      tables.set(name, []);
    }
    return tables.get(name);
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
    if (!where) {
      return true;
    }
    if (where.__op === 'or') {
      return where.operands.some((item) => matches(doc, item));
    }
    if (where.__op === 'and') {
      return where.operands.every((item) => matches(doc, item));
    }
    return Object.entries(where).every(([key, expected]) => {
      if (expected && expected.__op === 'neq') {
        return doc[key] !== expected.value;
      }
      if (expected && expected.__op === 'gt') {
        return Number(doc[key]) > expected.value;
      }
      if (expected && expected.__op === 'lt') {
        return typeof doc[key] === 'number' && doc[key] < expected.value;
      }
      if (expected && expected.__op === 'lte') {
        return typeof doc[key] === 'number' && doc[key] <= expected.value;
      }
      if (expected && expected.__op === 'exists') {
        const present = doc[key] !== undefined;
        return expected.value ? present : !present;
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
      async count() {
        const data = rows(name).filter((item) => matches(item, where));
        return { total: data.length };
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

  const db = {
    command: {
      neq(value) {
        return { __op: 'neq', value };
      },
      gt(value) {
        return { __op: 'gt', value };
      },
      lt(value) {
        return { __op: 'lt', value };
      },
      lte(value) {
        return { __op: 'lte', value };
      },
      inc(value) {
        return { __op: 'inc', value };
      },
      exists(value) {
        return { __op: 'exists', value };
      },
      or(operands) {
        return { __op: 'or', operands };
      },
      and(operands) {
        return { __op: 'and', operands };
      },
    },
    collection(name) {
      return Object.assign(query(name), {
        async add({ data }) {
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
              const next = Object.assign({ _id: id }, data);
              const index = rows(name).findIndex((item) => item._id === id);
              if (index >= 0) {
                rows(name)[index] = next;
              } else {
                rows(name).push(next);
              }
              return { _id: id, stats: { updated: index >= 0 ? 1 : 0, created: index >= 0 ? 0 : 1 } };
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
    async runTransaction(callback) {
      const previous = transactionTail;
      let release;
      transactionTail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        const result = await callback(db);
        if (afterFirstTransaction && !firstTransactionPaused) {
          firstTransactionPaused = true;
          await afterFirstTransaction();
        }
        return result;
      } finally {
        release();
      }
    },
  };
  return db;
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

test('第一次读取昵称不创建工单', async () => {
  const db = makeMemoryDb();
  const empty = await csGetProfile(db, { openid: 'user-1' });
  assert.deepEqual(empty, { ok: true, nickname: '', avatarFileId: '' });
  assert.equal((await db.collection('cs_threads').where({}).get()).data.length, 0);
  await csBindProfile(db, { openid: 'user-1', nickname: '张三', now: 1 });
  assert.equal((await csGetProfile(db, { openid: 'user-1' })).nickname, '张三');
});

test('资料集合不存在时先创建再读取', async () => {
  const rows = [];
  let gets = 0;
  const db = {
    created: [],
    async createCollection(name) {
      this.created.push(name);
    },
    collection() {
      return {
        where() {
          return {
            limit() {
              return {
                async get() {
                  gets += 1;
                  if (gets === 1) {
                    const error = new Error('database collection not exists');
                    error.errCode = -502005;
                    throw error;
                  }
                  return { data: rows };
                },
              };
            },
          };
        },
      };
    },
  };
  const result = await csGetProfile(db, { openid: 'user-1' });
  assert.deepEqual(result, { ok: true, nickname: '', avatarFileId: '' });
  assert.deepEqual(db.created, ['cs_profiles']);
});

test('昵称按微信身份保存，工单列表能读到', async () => {
  const db = makeMemoryDb();
  await csHistory(db, { openid: 'user-1', now: 100 });
  const saved = await csBindProfile(db, {
    openid: 'user-1',
    nickname: ' 张三 ',
    avatarFileId: 'cloud://avatar',
    now: 150,
  });
  assert.deepEqual(saved, { ok: true, nickname: '张三', avatarFileId: 'cloud://avatar' });

  const again = await csBindProfile(db, { openid: 'user-1', nickname: '李四', now: 180 });
  assert.equal(again.nickname, '李四');
  const history = await csHistory(db, { openid: 'user-1', now: 200 });
  assert.equal(history.nickname, '李四');

  const sent = await csSend(db, {
    openid: 'user-1',
    text: '型号问题',
    now: 220,
    notifyAdminsFn: async () => {},
  });
  const listed = await csAdminList(db, { now: 300 });
  assert.equal(listed.threads[0].nickname, '李四');
  const detail = await csAdminGet(db, { threadId: sent.thread._id });
  assert.equal(detail.thread.nickname, '李四');
  assert.equal(detail.thread.avatarFileId, 'cloud://avatar');
  assert.equal(listed.threads[0].avatarFileId, 'cloud://avatar');

  await assert.rejects(
    () => csBindProfile(db, { openid: 'user-1', nickname: '  ', now: 400 }),
    (error) => error.code === 'BAD_INPUT' && error.message === '请填写昵称',
  );
});

test('领取账号进入待处理且不自动回复', async () => {
  const db = makeMemoryDb();

  const sent = await csSend(db, {
    openid: 'user-1',
    text: '领取账号',
    faqId: 'claim',
    account: 'demo-account',
    now: 200,
    notifyAdminsFn: async () => {},
  });

  const result = await csAdminList(db, { now: 300 });
  assert.equal(sent.thread.status, 'waiting_human');
  assert.equal(result.threads.length, 1);
  assert.equal(result.threads[0]._id, sent.thread._id);
  assert.equal(
    sent.messages.some((message) => message.role === 'user' && message.text === '领取账号'),
    true,
  );
  assert.equal(
    sent.messages.some((message) => message.meta && message.meta.account === 'demo-account'),
    false,
  );
});

test('运营刚回复的 10 分钟内不再通知，过后用户再发会通知', async () => {
  const db = makeMemoryDb();
  const sent = await csSend(db, {
    openid: 'user-1',
    text: '你好',
    now: 1_000,
    notifyAdminsFn: async () => {},
  });
  await csClaimReply(db, { threadId: sent.thread._id, openid: 'wx-admin', now: 1_500 });
  await csAdminReply(db, {
    threadId: sent.thread._id,
    openid: 'wx-admin',
    text: '在的',
    now: 2_000,
  });
  const calls = [];
  await csSend(db, {
    openid: 'user-1',
    threadId: sent.thread._id,
    text: '马上再说',
    now: 2_000 + 599999,
    notifyAdminsFn: async () => calls.push('soon'),
  });
  await csSend(db, {
    openid: 'user-1',
    threadId: sent.thread._id,
    text: '过了十分钟',
    now: 2_000 + 600000,
    notifyAdminsFn: async () => calls.push('later'),
  });
  assert.deepEqual(calls, ['later']);
  const listed = await csAdminList(db, { status: 'active' });
  assert.equal(listed.threads[0].unread, true);
  assert.equal(listed.threads[0].preview, '过了十分钟');
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
  assert.equal(result.threads[0].unread, true);
});

test('运营回复后用户历史可见 operator 消息', async () => {
  const db = makeMemoryDb();
  const sent = await csSend(db, {
    openid: 'user-1',
    text: '请人工处理',
    now: 200,
    notifyAdminsFn: async () => {},
  });

  await csClaimReply(db, { threadId: sent.thread._id, openid: 'wx-admin', now: 250 });
  await csAdminReply(db, {
    threadId: sent.thread._id,
    openid: 'wx-admin',
    text: '已经为你处理',
    now: 300,
    notifyUserFn: async () => {},
  });
  const history = await csHistory(db, { openid: 'user-1', now: 400 });

  assert.equal(history.thread.status, 'human');
  assert.equal(history.messages.at(-1).role, 'operator');
  assert.equal(history.messages.at(-1).text, '已经为你处理');
});

test('没持有不能回复，持有后可以回复尚未升级的会话', async () => {
  const db = makeMemoryDb();
  const history = await csHistory(db, { openid: 'user-1', now: 100 });

  await assert.rejects(
    () =>
      csAdminReply(db, {
        threadId: history.thread._id,
        openid: 'wx-admin',
        text: '我来了',
        now: 200,
      }),
    (error) => error.code === 'CLAIM_REQUIRED',
  );
  const claimed = await csClaimReply(db, {
    threadId: history.thread._id,
    openid: 'wx-admin',
    now: 150,
  });
  assert.equal(claimed.thread.replyClaimOpenid, 'wx-admin');
  const replied = await csAdminReply(db, {
    threadId: history.thread._id,
    openid: 'wx-admin',
    text: '我来了',
    now: 200,
    notifyUserFn: async () => {},
  });
  assert.equal(replied.thread.status, 'human');
  assert.equal(replied.messages.at(-1).text, '我来了');
});

test('closed 工单不能接手', async () => {
  const db = makeMemoryDb();
  const thread = await createWaitingThread(db);
  await csClaimReply(db, { threadId: thread._id, openid: 'wx-a', now: 1_000 });
  await csAdminClose(db, { threadId: thread._id, openid: 'wx-a', now: 1_100 });

  await assert.rejects(
    () => csClaimReply(db, { threadId: thread._id, openid: 'wx-b', now: 1_200 }),
    { code: 'INVALID_STATE' },
  );

  const stored = (await csAdminGet(db, { threadId: thread._id })).thread;
  assert.equal(stored.status, 'closed');
  assert.equal(stored.replyClaimOpenid, '');
  assert.equal(stored.replyClaimAt, 0);
});

test('关闭线程后用户再次发送会创建新线程', async () => {
  const db = makeMemoryDb();
  const first = await csSend(db, {
    openid: 'user-1',
    text: '请人工处理',
    now: 200,
    notifyAdminsFn: async () => {},
  });
  await csClaimReply(db, { threadId: first.thread._id, openid: 'wx-admin', now: 250 });
  await csAdminClose(db, { threadId: first.thread._id, openid: 'wx-admin', now: 300 });

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
  await csClaimReply(db, { threadId: first.thread._id, openid: 'wx-admin', now: 250 });
  await csAdminClose(db, { threadId: first.thread._id, openid: 'wx-admin', now: 300 });

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

test('旧会话只读最近一页消息，并记住最新一句', async () => {
  const db = makeMemoryDb({ rejectOrderBy: true });
  const added = await db.collection('cs_threads').add({
    data: { openid: 'user-1', status: 'human', createdAt: 1, updatedAt: 1 },
  });
  for (let index = 1; index <= 120; index += 1) {
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

  const listed = await csAdminList(db, { status: 'human' });
  assert.equal(listed.threads[0].preview, '120');
  assert.equal(listed.threads[0].unread, true);
  const stored = await db.collection('cs_threads').doc(added._id).get();
  assert.equal(stored.data.attentionText, '120');

  await db.collection('cs_messages').add({
    data: {
      threadId: added._id,
      openid: 'user-1',
      role: 'user',
      text: '999',
      createdAt: 999,
    },
  });
  const again = await csAdminList(db, { status: 'human' });
  assert.equal(again.threads[0].preview, '120');
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
  let releaseFirst;
  const hold = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let enteredResolve;
  const entered = new Promise((resolve) => {
    enteredResolve = resolve;
  });
  const db = makeMemoryDb({
    async afterFirstTransaction() {
      enteredResolve();
      await hold;
    },
  });

  const firstCall = csRegisterNotify(db, {
    openid: 'wx-race',
    templateId: 'tpl',
    now: 1,
  });
  let secondSettled = false;
  const secondCall = csRegisterNotify(db, {
    openid: 'wx-race',
    templateId: 'tpl',
    now: 2,
  }).then((result) => {
    secondSettled = true;
    return result;
  });
  let timeout;
  try {
    await Promise.race([
      entered,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('首笔事务在提交前没有拦住第二笔')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondSettled, false);

  const whileHeld = await db.collection('admin_notify_subscribers').where({ openid: 'wx-race' }).get();
  assert.equal(whileHeld.data.length, 1);
  assert.equal(whileHeld.data[0]._id, 'wx-race');
  assert.equal(whileHeld.data[0].quota, 1);

  releaseFirst();
  const first = await firstCall;
  assert.equal(first.quota, whileHeld.data[0].quota);

  const second = await secondCall;
  const stored = await db.collection('admin_notify_subscribers').where({ openid: 'wx-race' }).get();
  assert.equal(stored.data.length, 1);
  assert.equal(stored.data[0]._id, 'wx-race');
  assert.equal(stored.data[0].quota, 2);
  assert.equal(second.quota, stored.data[0].quota);
  assert.equal((await listNotifyCandidates(db, { templateId: 'tpl' })).length, 1);
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

async function findSubscriberCount(db, openid) {
  const result = await db.collection('admin_notify_subscribers').where({ openid }).get();
  return result.data.length;
}

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

test('手机号绑定写入并开启', async () => {
  const db = makeMemoryDb();
  const result = await csBindWecom(db, {
    openid: 'wx-1',
    mobile: '13800000000',
    now: 10,
    exchangeCode: async () => {
      throw new Error('should not exchange');
    },
  });
  assert.deepEqual(result, { ok: true, bound: true, enabled: true });
  const row = (await db.collection('admin_notify_subscribers').where({ openid: 'wx-1' }).get()).data[0];
  assert.equal(row.wecomUserId, '13800000000');
});

test('空 code 拒绝绑定且不写库', async () => {
  const db = makeMemoryDb();
  let exchanged = false;
  await assert.rejects(
    () => csBindWecom(db, {
      openid: 'wx-1',
      code: '',
      now: 10,
      exchangeCode: async () => {
        exchanged = true;
        return { corpid: 'corp-1', userid: 'zhangsan' };
      },
    }),
    (error) => error.code === 'BIND_FAILED',
  );
  assert.equal(exchanged, false);
  assert.equal(await findSubscriberCount(db, 'wx-1'), 0);
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
    (error) => error.code === 'BIND_FAILED' && error.message === '企业 ID 不一致',
  );
  await assert.rejects(
    () => csBindWecom(db, {
      openid: 'wx-1',
      code: 'code-1',
      now: 10,
      exchangeCode: async () => ({ corpid: 'corp-1', userid: 'zhangsan' }),
      expectedCorpId: '',
    }),
    (error) => error.code === 'BIND_FAILED' && error.message === '云函数未配置企业 ID',
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

async function createWaitingThread(db) {
  const added = await db.collection('cs_threads').add({
    data: {
      openid: 'user-1',
      status: 'waiting_human',
      createdAt: 1,
      updatedAt: 1,
    },
  });
  return (await db.collection('cs_threads').doc(added._id).get()).data;
}

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

test('别人持有时不能回复，超时或放开后可以', async () => {
  const db = makeMemoryDb();
  const thread = await createWaitingThread(db);
  await csClaimReply(db, { threadId: thread._id, openid: 'wx-a', now: 1_500 });
  const first = await csAdminReply(db, {
    threadId: thread._id,
    openid: 'wx-a',
    text: '我来',
    now: 2_000,
  });
  assert.equal(first.thread.replyClaimOpenid, 'wx-a');
  await assert.rejects(
    () => csAdminReply(db, { threadId: thread._id, openid: 'wx-b', text: '我也来', now: 2_000 + 599999 }),
    (error) => error.code === 'CLAIM_REQUIRED',
  );
  await assert.rejects(
    () => csClaimReply(db, { threadId: thread._id, openid: 'wx-b', now: 2_000 + 599999 }),
    (error) => error.code === 'CLAIMED',
  );
  const released = await csReleaseReply(db, { threadId: thread._id, openid: 'wx-a', now: 2_100 });
  assert.equal(released.thread.replyClaimOpenid, '');
  await assert.rejects(
    () => csAdminReply(db, { threadId: thread._id, openid: 'wx-b', text: '现在我来', now: 3_000 }),
    (error) => error.code === 'CLAIM_REQUIRED',
  );
  await csClaimReply(db, { threadId: thread._id, openid: 'wx-b', now: 2_900 });
  const taken = await csAdminReply(db, {
    threadId: thread._id,
    openid: 'wx-b',
    text: '现在我来',
    now: 3_000,
  });
  assert.equal(taken.thread.replyClaimOpenid, 'wx-b');
  await assert.rejects(
    () => csAdminReply(db, { threadId: thread._id, openid: 'wx-a', text: '十分钟后', now: 3_000 + 600000 }),
    (error) => error.code === 'CLAIM_REQUIRED',
  );
  await csClaimReply(db, { threadId: thread._id, openid: 'wx-a', now: 3_000 + 600000 });
  const later = await csAdminReply(db, {
    threadId: thread._id,
    openid: 'wx-a',
    text: '十分钟后',
    now: 3_000 + 600000,
  });
  assert.equal(later.thread.replyClaimOpenid, 'wx-a');
  assert.equal(later.messages.at(-1).text, '十分钟后');
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

test('打开会话才把对方消息记成已读', async () => {
  const db = makeMemoryDb();
  await csHistory(db, { openid: 'user-1', now: 100 });
  const sent = await csSend(db, {
    openid: 'user-1',
    text: '在吗',
    now: 200,
    notifyAdminsFn: async () => {},
  });
  const listed = await csAdminList(db, { status: 'active' });
  assert.equal(listed.threads[0].operatorSeenAt || 0, 0);
  assert.equal(sent.thread.userSeenAt, 200);

  const opened = await csAdminGet(db, { threadId: sent.thread._id, now: 300 });
  assert.equal(opened.thread.operatorSeenAt, 300);
  await csClaimReply(db, { threadId: sent.thread._id, openid: 'wx-a', now: 350 });

  const replied = await csAdminReply(db, {
    threadId: sent.thread._id,
    openid: 'wx-a',
    text: '在的',
    now: 400,
  });
  assert.equal(replied.thread.operatorSeenAt, 400);
  assert.equal(replied.thread.userSeenAt, 200);
  const operatorMessage = replied.messages.find((item) => item.role === 'operator');
  assert.equal(operatorMessage.createdAt <= replied.thread.userSeenAt, false);

  const seen = await csHistory(db, { openid: 'user-1', now: 500 });
  assert.equal(seen.thread.userSeenAt, 500);
  assert.equal(operatorMessage.createdAt <= seen.thread.userSeenAt, true);
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

module.exports = { makeMemoryDb };
