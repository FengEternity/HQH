'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { deliverWecomAdminNotifications } = require('./wecomDelivery');

const CLAIM_WINDOW_MS = 120000;

function seed(db, docs) {
  return Promise.all(docs.map((data) => db.collection('admin_notify_subscribers').add({ data })));
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
    if (expected && expected.__op === 'exists') {
      const present = doc[key] !== undefined;
      return expected.value ? present : !present;
    }
    if (expected && expected.__op === 'lt') {
      return typeof doc[key] === 'number' && doc[key] < expected.value;
    }
    if (expected && expected.__op === 'gt') {
      return typeof doc[key] === 'number' && doc[key] > expected.value;
    }
    if (expected && expected.__op === 'neq') {
      return doc[key] !== expected.value;
    }
    return doc[key] === expected;
  });
}

function applyPatch(item, data) {
  Object.entries(data || {}).forEach(([key, value]) => {
    if (value && value.__op === 'remove') {
      delete item[key];
      return;
    }
    item[key] = value;
  });
}

function makeMemoryDb({ holdNotifyClaim = false } = {}) {
  const tables = new Map();
  let nextId = 1;

  function rows(name) {
    if (!tables.has(name)) {
      tables.set(name, []);
    }
    return tables.get(name);
  }

  function query(name, where) {
    return {
      where(nextWhere) {
        return query(name, nextWhere);
      },
      async get() {
        const data = rows(name)
          .filter((item) => matches(item, where))
          .map((item) => Object.assign({}, item));
        return { data };
      },
      async update({ data }) {
        if (holdNotifyClaim && data && typeof data.adminNotifyClaimedAt === 'number') {
          const nextAt = data.adminNotifyClaimedAt;
          const held = rows(name).some((item) => {
            const claimedAt = item.adminNotifyClaimedAt;
            return typeof claimedAt === 'number' && nextAt - claimedAt < CLAIM_WINDOW_MS;
          });
          if (held) {
            return { stats: { updated: 0 } };
          }
        }
        let updated = 0;
        rows(name).forEach((item) => {
          if (matches(item, where)) {
            applyPatch(item, data);
            updated += 1;
          }
        });
        return { stats: { updated } };
      },
    };
  }

  return {
    command: {
      lt(value) {
        return { __op: 'lt', value };
      },
      gt(value) {
        return { __op: 'gt', value };
      },
      neq(value) {
        return { __op: 'neq', value };
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
      remove() {
        return { __op: 'remove' };
      },
    },
    collection(name) {
      return Object.assign(query(name), {
        async add({ data }) {
          const _id = data && data._id ? data._id : `id-${nextId++}`;
          rows(name).push(Object.assign({ _id }, data));
          return { _id };
        },
        doc(id) {
          return {
            async get() {
              const data = rows(name).find((item) => item._id === id);
              return { data: data ? Object.assign({}, data) : null };
            },
            async update({ data }) {
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

test('有人开启时群按手机号 @，个人通道记为跳过', async () => {
  const db = makeMemoryDb();
  await db.collection('cs_threads').add({ data: { _id: 'thread-1' } });
  await seed(db, [
    { openid: 'a', enabled: true, wecomUserId: '13800000000' },
    { openid: 'b', enabled: false, wecomUserId: '13900000000' },
    { openid: 'c', enabled: true, wecomUserId: '' },
  ]);
  const seen = [];
  await deliverWecomAdminNotifications(db, {
    threadId: 'thread-1',
    now: 100,
    page: 'pages/admin/ticket/ticket?id=thread-1',
    env: { WECOM_GROUP_WEBHOOK: 'https://example.test/webhook', WECOM_MINI_APPID: 'wx-app' },
    client: {
      sendPersonal: async () => seen.push('personal'),
      sendGroup: async (payload) => seen.push(payload.userIds),
    },
  });
  assert.deepEqual(seen, [['13800000000']]);
  const thread = (await db.collection('cs_threads').doc('thread-1').get()).data;
  assert.equal(thread.adminNotifyPersonalResult, 'skipped');
});

test('下一次调用会再次发送群通知', async () => {
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
  assert.deepEqual(second, ['group']);
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
  assert.equal(thread.adminNotifyPersonalResult, 'skipped');
});

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
  assert.deepEqual(seen, ['group']);
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

test('待处理工单 (waiting_human) 用户再发消息时群机器人会再次发送', async () => {
  const db = makeMemoryDb();
  await db.collection('cs_threads').add({
    data: { _id: 'thread-1', status: 'waiting_human' },
  });
  await seed(db, [{ openid: 'a', enabled: true, wecomUserId: '13800000000' }]);
  const seen = [];
  const env = { WECOM_GROUP_WEBHOOK: 'https://example.test/webhook', WECOM_MINI_APPID: 'wx-app' };
  const client = {
    sendGroup: async (payload) => {
      seen.push(payload.userIds);
      return { errcode: 0 };
    },
    sendPersonal: async () => ({ errcode: 0 }),
  };

  await deliverWecomAdminNotifications(db, {
    threadId: 'thread-1',
    now: 100,
    page: 'pages/admin/ticket/ticket?id=thread-1',
    env,
    client,
  });

  const threadAfterFirst = (await db.collection('cs_threads').doc('thread-1').get()).data;
  assert.equal(threadAfterFirst.adminNotifyGroupResult, 'sent');
  assert.equal(seen.length, 1);

  // 用户在依然是 waiting_human 状态下发送第二条消息（如“测试一下 1701”）
  await deliverWecomAdminNotifications(db, {
    threadId: 'thread-1',
    now: 200,
    page: 'pages/admin/ticket/ticket?id=thread-1',
    env,
    client,
  });

  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], ['13800000000']);
});

test('未配群机器人时跳过，配置后用户新消息可补发', async () => {
  const db = makeMemoryDb();
  await db.collection('cs_threads').add({
    data: { _id: 'thread-1', status: 'waiting_human' },
  });
  await seed(db, [{ openid: 'a', enabled: true, wecomUserId: '13800000000' }]);
  const seen = [];

  // 第一次发送时环境变量尚未配置 WECOM_GROUP_WEBHOOK
  await deliverWecomAdminNotifications(db, {
    threadId: 'thread-1',
    now: 100,
    page: 'pages/admin/ticket/ticket?id=thread-1',
    env: { WECOM_GROUP_WEBHOOK: '', WECOM_MINI_APPID: 'wx-app' },
    client: {
      sendGroup: async () => seen.push('group'),
      sendPersonal: async () => ({ errcode: 0 }),
    },
  });

  assert.equal(seen.length, 0);

  // 后续运维配置了 Webhook，用户发了新消息
  await deliverWecomAdminNotifications(db, {
    threadId: 'thread-1',
    now: 200,
    page: 'pages/admin/ticket/ticket?id=thread-1',
    env: { WECOM_GROUP_WEBHOOK: 'https://example.test/webhook', WECOM_MINI_APPID: 'wx-app' },
    client: {
      sendGroup: async () => {
        seen.push('group');
        return { errcode: 0 };
      },
      sendPersonal: async () => ({ errcode: 0 }),
    },
  });

  assert.equal(seen.length, 1);
  const thread = (await db.collection('cs_threads').doc('thread-1').get()).data;
  assert.equal(thread.adminNotifyGroupResult, 'sent');
});
