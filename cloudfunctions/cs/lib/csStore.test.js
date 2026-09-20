'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  csAdminList,
  csAdminReply,
  csAdminClose,
  csHistory,
  csSend,
} = require('./csStore');

function makeMemoryDb() {
  const tables = new Map();
  let nextId = 1;

  function rows(name) {
    if (!tables.has(name)) {
      tables.set(name, []);
    }
    return tables.get(name);
  }

  function matches(doc, where) {
    return Object.entries(where || {}).every(([key, expected]) => {
      if (expected && expected.__op === 'neq') {
        return doc[key] !== expected.value;
      }
      return doc[key] === expected;
    });
  }

  function query(name, where = {}, order, max) {
    return {
      where(extra) {
        return query(name, Object.assign({}, where, extra), order, max);
      },
      orderBy(field, direction) {
        return query(name, where, { field, direction }, max);
      },
      limit(value) {
        return query(name, where, order, value);
      },
      async get() {
        let data = rows(name).filter((item) => matches(item, where));
        if (order) {
          const sign = order.direction === 'desc' ? -1 : 1;
          data = data.slice().sort((a, b) => sign * (a[order.field] - b[order.field]));
        }
        if (max !== undefined) {
          data = data.slice(0, max);
        }
        return { data: data.map((item) => Object.assign({}, item)) };
      },
      async update({ data }) {
        let updated = 0;
        for (const item of rows(name)) {
          if (matches(item, where)) {
            Object.assign(item, data);
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
            async update({ data }) {
              const item = rows(name).find((entry) => entry._id === id);
              if (!item) {
                return { stats: { updated: 0 } };
              }
              Object.assign(item, data);
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
    text: '新的问题',
    now: 400,
    notifyAdminsFn: async () => {},
  });

  assert.notEqual(second.thread._id, first.thread._id);
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
    { code: 'FORBIDDEN' },
  );
});

module.exports = { makeMemoryDb };
