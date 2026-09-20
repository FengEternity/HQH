'use strict';

const { welcome, welcomeActions } = require('./contactCopy');
const { assertUserText } = require('./csFaq');
const { planSend } = require('./csSendFlow');
const { onClose, onOperatorFirstReply } = require('./csThreadState');

const THREADS = 'cs_threads';
const MESSAGES = 'cs_messages';
const SUBSCRIBERS = 'admin_notify_subscribers';

function codedError(code) {
  const error = new Error(code);
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
    .orderBy('createdAt', 'asc')
    .get();
  return result.data || [];
}

async function getOpenThread(db, openid) {
  const result = await db
    .collection(THREADS)
    .where({ openid, status: db.command.neq('closed') })
    .limit(1)
    .get();
  return (result.data && result.data[0]) || null;
}

async function addMessage(db, thread, message, now) {
  const data = Object.assign({}, message, {
    threadId: thread._id,
    openid: thread.openid,
    createdAt: now,
  });
  await db.collection(MESSAGES).add({ data });
}

async function updateStatus(db, thread, nextStatus, now) {
  const result = await db
    .collection(THREADS)
    .where({ _id: thread._id, status: thread.status })
    .update({ data: { status: nextStatus, updatedAt: now } });
  if (!result.stats || result.stats.updated === 0) {
    throw codedError('INVALID_STATE');
  }
  return Object.assign({}, thread, { status: nextStatus, updatedAt: now });
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
  return { ok: true, thread, messages: await getMessages(db, thread._id) };
}

async function resolveUserThread(db, input) {
  if (!input.threadId) {
    return (await csHistory(db, input)).thread;
  }
  const thread = await getThread(db, input.threadId);
  if (thread.openid !== input.openid) {
    throw codedError('FORBIDDEN');
  }
  return thread;
}

async function csSend(db, input) {
  let thread = await resolveUserThread(db, input);
  const existingMessages = await getMessages(db, thread._id);
  const plan = planSend({
    status: thread.status,
    text: input.text,
    faqId: input.faqId,
    account: input.account,
    wechatId: input.wechatId,
    phone: input.phone,
    hasEscalateSystem: existingMessages.some(
      (message) => message.meta && message.meta.event === 'escalated',
    ),
  });

  thread = await updateStatus(db, thread, plan.nextStatus, input.now);
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
  return { ok: true, thread, messages: await getMessages(db, thread._id) };
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
  const nextStatus = onOperatorFirstReply(thread.status);
  thread = await updateStatus(db, thread, nextStatus, now);
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
  const thread = await updateStatus(db, current, onClose(current.status), now);
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
