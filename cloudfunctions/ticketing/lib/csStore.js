'use strict';

const { newTicketData, subscribeErrorCode } = require('./notify');
const { welcome, welcomeActions } = require('./contactCopy');
const { assertUserText } = require('./csFaq');
const { planSend } = require('./csSendFlow');
const { onClose, onOperatorFirstReply } = require('./csThreadState');

const THREADS = 'cs_threads';
const MESSAGES = 'cs_messages';
const SUBSCRIBERS = 'admin_notify_subscribers';

const ERROR_MESSAGES = {
  INVALID_STATE: '当前状态不支持此操作，请刷新后重试',
  FORBIDDEN: '无权访问该会话',
  NOT_FOUND: '会话不存在',
  BAD_INPUT: '输入内容不正确',
};

function codedError(code) {
  const error = new Error(ERROR_MESSAGES[code] || '请求失败');
  error.code = code;
  return error;
}

async function getThread(db, threadId) {
  const result = await db.collection(THREADS).doc(threadId).get();
  if (!result.data) {
    throw codedError('NOT_FOUND');
  }
  return result.data;
}

async function listWhere(collection, where) {
  const pageSize = 100;
  const rows = [];
  let skip = 0;
  while (rows.length < 1000) {
    const result = await collection.where(where).skip(skip).limit(pageSize).get();
    const batch = result.data || [];
    rows.push(...batch);
    if (batch.length < pageSize) {
      return rows;
    }
    skip += batch.length;
  }
  return rows;
}

function byTime(field, direction) {
  const sign = direction === 'desc' ? -1 : 1;
  return (left, right) =>
    sign * ((Number(left[field]) || 0) - (Number(right[field]) || 0));
}

async function getMessages(db, threadId) {
  const rows = await listWhere(db.collection(MESSAGES), { threadId });
  return rows.sort(byTime('createdAt', 'asc')).slice(-500);
}

async function getOpenThread(db, openid) {
  const result = await db
    .collection(THREADS)
    .where({ openid, status: db.command.neq('closed') })
    .limit(1)
    .get();
  return (result.data && result.data[0]) || null;
}

async function getLatestClosedThread(db, openid) {
  const rows = await listWhere(db.collection(THREADS), { openid, status: 'closed' });
  rows.sort(byTime('updatedAt', 'desc'));
  return rows[0] || null;
}

async function getConversationMessages(db, thread) {
  const closed = await getLatestClosedThread(db, thread.openid);
  const previous = closed ? await getMessages(db, closed._id) : [];
  return previous.concat(await getMessages(db, thread._id));
}

async function addMessage(db, thread, message, now) {
  const data = Object.assign({}, message, {
    threadId: thread._id,
    openid: thread.openid,
    createdAt: now,
  });
  await db.collection(MESSAGES).add({ data });
}

async function updateStatus(db, thread, transition, now) {
  let current = thread;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const nextStatus = transition(current.status);
    const result = await db
      .collection(THREADS)
      .where({ _id: current._id, status: current.status })
      .update({ data: { status: nextStatus, updatedAt: now } });
    if (result.stats && result.stats.updated > 0) {
      return Object.assign({}, current, { status: nextStatus, updatedAt: now });
    }
    current = await getThread(db, current._id);
  }
  throw codedError('INVALID_STATE');
}

async function csHistory(db, { openid, now }) {
  let thread = await getOpenThread(db, openid);
  if (!thread) {
    const data = {
      openid,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    };
    const added = await db.collection(THREADS).add({ data });
    thread = Object.assign({ _id: added._id }, data);
    await addMessage(
      db,
      thread,
      {
        role: 'assistant',
        text: welcome,
        meta: { source: 'rule', actions: welcomeActions },
      },
      now,
    );
  }
  return { ok: true, thread, messages: await getConversationMessages(db, thread) };
}

async function resolveUserThread(db, input) {
  if (!input.threadId) {
    return (await csHistory(db, input)).thread;
  }
  let thread;
  try {
    thread = await getThread(db, input.threadId);
  } catch (error) {
    if (error.code === 'NOT_FOUND') {
      return (await csHistory(db, input)).thread;
    }
    throw error;
  }
  if (thread.openid !== input.openid) {
    throw codedError('FORBIDDEN');
  }
  if (thread.status === 'closed') {
    return (await csHistory(db, input)).thread;
  }
  return thread;
}

async function csSend(db, input) {
  let thread = await resolveUserThread(db, input);
  const existingMessages = await getMessages(db, thread._id);
  let plan;
  thread = await updateStatus(
    db,
    thread,
    (status) => {
      plan = planSend({
        status,
        text: input.text,
        faqId: input.faqId,
        account: input.account,
        wechatId: input.wechatId,
        phone: input.phone,
        hasEscalateSystem:
          status !== 'open' ||
          existingMessages.some(
            (message) => message.meta && message.meta.event === 'escalated',
          ),
      });
      return plan.nextStatus;
    },
    input.now,
  );
  for (const message of plan.messages) {
    await addMessage(db, thread, message, input.now);
  }
  if (plan.notifyAdmins && input.notifyAdminsFn) {
    try {
      await input.notifyAdminsFn(thread);
    } catch (error) {
      console.error('cs notify admins failed', error);
    }
  }
  return { ok: true, thread, messages: await getConversationMessages(db, thread) };
}

function csEscalate(db, input) {
  return csSend(
    db,
    Object.assign({}, input, {
      text: input.text || '转人工',
      faqId: 'human',
    }),
  );
}

async function csAdminList(db, { status = 'waiting_human' }) {
  // 只按状态取出再在内存排序。where 加 orderBy 需要组合索引，缺索引时云数据库直接失败，工作台会显示成没有工单。
  const rows = await listWhere(db.collection(THREADS), { status });
  rows.sort(byTime('updatedAt', 'desc'));
  const threads = [];
  for (const thread of rows.slice(0, 100)) {
    const messages = await getMessages(db, thread._id);
    const lastUser = messages
      .slice()
      .reverse()
      .find((message) => message.role === 'user');
    const last = lastUser || messages[messages.length - 1];
    threads.push(Object.assign({}, thread, { preview: last ? String(last.text || '') : '' }));
  }
  return { ok: true, threads };
}

async function csAdminGet(db, { threadId }) {
  const thread = await getThread(db, threadId);
  return { ok: true, thread, messages: await getMessages(db, threadId) };
}

async function csAdminReply(db, { threadId, text, now, notifyUserFn }) {
  const body = assertUserText(text);
  let thread = await getThread(db, threadId);
  thread = await updateStatus(db, thread, onOperatorFirstReply, now);
  await addMessage(db, thread, { role: 'operator', text: body }, now);
  if (notifyUserFn) {
    try {
      await notifyUserFn(thread);
    } catch (error) {
      console.error('cs notify user failed', error);
    }
  }
  return { ok: true, thread, messages: await getMessages(db, threadId) };
}

async function csAdminClose(db, { threadId, now }) {
  const current = await getThread(db, threadId);
  const thread = await updateStatus(db, current, onClose, now);
  return { ok: true, thread };
}

function assertIdentity(openid, templateId) {
  if (!openid || !templateId) {
    throw codedError('BAD_INPUT');
  }
}

async function findSubscriber(db, openid) {
  const existing = await db.collection(SUBSCRIBERS).where({ openid }).limit(1).get();
  return (existing.data && existing.data[0]) || null;
}

function duplicateOpenidError() {
  const error = new Error('同一微信已存在通知订阅记录');
  error.code = 'DUPLICATE_OPENID';
  return error;
}

async function updateRegisterNotify(db, current, { templateId, now }) {
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

async function createRegisterNotify(db, { openid, templateId, now }) {
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
  if (typeof db._awaitBeforeSubscriberAdd === 'function') {
    await db._awaitBeforeSubscriberAdd();
  }
  const docRef = db.collection(SUBSCRIBERS).doc(openid);
  if (typeof docRef.set === 'function') {
    await docRef.set({ data });
    return { ok: true, enabled: true, quota: 1 };
  }
  await db.collection(SUBSCRIBERS).add({ data });
  return { ok: true, enabled: true, quota: 1 };
}

async function csRegisterNotify(db, { openid, templateId, now }) {
  assertIdentity(openid, templateId);
  let current = await findSubscriber(db, openid);
  if (!current) {
    try {
      return await createRegisterNotify(db, { openid, templateId, now });
    } catch (error) {
      if (error.code !== 'DUPLICATE_OPENID') {
        throw error;
      }
      current = await findSubscriber(db, openid);
      if (!current) {
        throw error;
      }
    }
  }
  return updateRegisterNotify(db, current, { templateId, now });
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
    let outcome = 'sent';
    let errorCode = 0;
    try {
      const result = await send({
        touser: candidate.openid,
        templateId,
        page,
        data: newTicketData(now),
      });
      const code = subscribeErrorCode(result);
      if (code === 43101) {
        outcome = 'unsubscribed';
        errorCode = 43101;
      } else if (code) {
        outcome = 'failed';
        errorCode = code;
      }
    } catch (error) {
      const code = subscribeErrorCode(error);
      outcome = code === 43101 ? 'unsubscribed' : 'failed';
      errorCode = code;
    }
    try {
      await finishNotifySend(db, {
        id: candidate._id,
        outcome,
        errorCode,
        now,
      });
    } catch (error) {
      console.error('cs notify settle failed', error);
    }
    if (outcome === 'sent') {
      sent += 1;
    } else {
      skipped += 1;
    }
  }
  return { ok: true, sent, skipped };
}

module.exports = {
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
  listNotifyCandidates,
  reserveNotifySend,
  finishNotifySend,
  deliverAdminNotifications,
};
