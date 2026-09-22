'use strict';

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

async function getMessages(db, threadId) {
  const result = await db
    .collection(MESSAGES)
    .where({ threadId })
    .orderBy('createdAt', 'desc')
    .limit(500)
    .get();
  return (result.data || [])
    .slice()
    .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0));
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
  const result = await db
    .collection(THREADS)
    .where({ openid, status: 'closed' })
    .orderBy('updatedAt', 'desc')
    .limit(1)
    .get();
  return (result.data && result.data[0]) || null;
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
  const result = await db
    .collection(THREADS)
    .where({ status })
    .orderBy('updatedAt', 'desc')
    .limit(100)
    .get();
  return { ok: true, threads: result.data || [] };
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

async function csRegisterNotify(db, { openid, now }) {
  const existing = await db.collection(SUBSCRIBERS).where({ openid }).limit(1).get();
  if (existing.data && existing.data.length) {
    return { ok: true, subscriber: existing.data[0] };
  }
  const data = { openid, createdAt: now, updatedAt: now };
  const added = await db.collection(SUBSCRIBERS).add({ data });
  return { ok: true, subscriber: Object.assign({ _id: added._id }, data) };
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
};
