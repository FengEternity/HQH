'use strict';

const { newTicketData, subscribeErrorCode } = require('./notify');
const { welcome, welcomeActions } = require('./contactCopy');
const { assertUserText } = require('./csFaq');
const { planSend } = require('./csSendFlow');
const { onClose, onOperatorFirstReply } = require('./csThreadState');

const THREADS = 'cs_threads';
const MESSAGES = 'cs_messages';
const PROFILES = 'cs_profiles';
const SUBSCRIBERS = 'admin_notify_subscribers';
const CLAIM_WINDOW_MS = 600000;

const ERROR_MESSAGES = {
  INVALID_STATE: '当前状态不支持此操作，请刷新后重试',
  FORBIDDEN: '无权访问该会话',
  NOT_FOUND: '会话不存在',
  BAD_INPUT: '输入内容不正确',
  BIND_FAILED: '绑定失败',
  UNBOUND: '请先绑定企业微信',
  CLAIMED: '同事正在回复',
  CLAIM_REQUIRED: '请先持有会话',
};

function codedError(code, message) {
  const error = new Error(message || ERROR_MESSAGES[code] || '请求失败');
  error.code = code;
  return error;
}

async function getThread(db, threadId) {
  const result = await db.collection(THREADS).doc(threadId).get();
  if (!result.data) {
    throw codedError('NOT_FOUND');
  }
  return Object.assign({ _id: threadId }, result.data);
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

function latestPatch(message, now) {
  const text = String((message && message.text) || '');
  const role = String((message && message.role) || '');
  const patch = { lastText: text, lastRole: role, lastAt: now };
  if (role === 'user' || role === 'operator') {
    patch.attentionText = text;
    patch.attentionRole = role;
  }
  return patch;
}

async function addMessage(db, thread, message, now) {
  const data = Object.assign({}, message, {
    threadId: thread._id,
    openid: thread.openid,
    createdAt: now,
  });
  await db.collection(MESSAGES).add({ data });
  if (thread && thread._id) {
    await db.collection(THREADS).doc(thread._id).update({ data: latestPatch(message, now) });
  }
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

async function markSeen(db, thread, field, now) {
  const seenAt = Number(now);
  if (!thread || !thread._id || !Number.isFinite(seenAt)) {
    return thread;
  }
  if ((Number(thread[field]) || 0) >= seenAt) {
    return thread;
  }
  await db.collection(THREADS).doc(thread._id).update({
    data: { [field]: seenAt },
  });
  return Object.assign({}, thread, { [field]: seenAt });
}

async function csHistory(db, { openid, now }) {
  let thread = await getOpenThread(db, openid);
  if (!thread) {
    const data = {
      openid,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      userSeenAt: now,
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
  thread = await markSeen(db, thread, 'userSeenAt', now);
  const profile = await readProfile(db, openid);
  return {
    ok: true,
    thread,
    nickname: profile && profile.nickname ? profile.nickname : '',
    messages: await getConversationMessages(db, thread),
  };
}

function assertNickname(raw) {
  const nickname = String(raw ?? '').trim();
  if (!nickname) {
    throw codedError('BAD_INPUT', '请填写昵称');
  }
  if (nickname.length > 32) {
    throw codedError('BAD_INPUT', '昵称太长');
  }
  return nickname;
}

function isMissingCollection(error) {
  const code = error && (error.errCode || error.code);
  const msg = String((error && (error.errMsg || error.message)) || '');
  return code === -502005 || /collection not exist/i.test(msg);
}

async function withProfiles(db, fn) {
  try {
    return await fn();
  } catch (error) {
    if (!isMissingCollection(error) || typeof db.createCollection !== 'function') {
      throw error;
    }
    try {
      await db.createCollection(PROFILES);
    } catch (createError) {
      const createMsg = String((createError && (createError.errMsg || createError.message)) || '');
      const createCode = createError && (createError.errCode || createError.code);
      if (createCode !== -501001 && !/already exists/i.test(createMsg) && createMsg.indexOf('集合已存在') < 0) {
        throw error;
      }
    }
    return await fn();
  }
}

async function readProfile(db, openid) {
  if (!openid) {
    return null;
  }
  return withProfiles(db, async () => {
    const result = await db.collection(PROFILES).where({ openid }).limit(1).get();
    return (result.data && result.data[0]) || null;
  });
}

async function profileOf(db, openid, cache) {
  if (!openid) {
    return { nickname: '', avatarFileId: '' };
  }
  if (cache.has(openid)) {
    return cache.get(openid);
  }
  const profile = await readProfile(db, openid);
  const summary = {
    nickname: profile && profile.nickname ? String(profile.nickname) : '',
    avatarFileId: profile && profile.avatarFileId ? String(profile.avatarFileId) : '',
  };
  cache.set(openid, summary);
  return summary;
}

async function csBindProfile(db, { openid, nickname, avatarFileId, now }) {
  if (!openid) {
    throw codedError('BAD_INPUT');
  }
  const name = assertNickname(nickname);
  const current = await readProfile(db, openid);
  const nextAvatar = typeof avatarFileId === 'string' ? avatarFileId.trim() : '';
  const storedAvatar = nextAvatar || (current && current.avatarFileId) || '';
  await withProfiles(db, () => db.collection(PROFILES).doc(openid).set({
    data: {
      openid,
      nickname: name,
      avatarFileId: storedAvatar,
      boundAt: current && current.boundAt ? current.boundAt : now,
      updatedAt: now,
    },
  }));
  return { ok: true, nickname: name, avatarFileId: storedAvatar };
}

async function csGetProfile(db, { openid }) {
  const profile = await readProfile(db, openid);
  return {
    ok: true,
    nickname: profile && profile.nickname ? profile.nickname : '',
    avatarFileId: profile && profile.avatarFileId ? profile.avatarFileId : '',
  };
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
        now: input.now,
        lastOperatorAt: lastOperatorAt(existingMessages),
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
  thread = await markSeen(db, thread, 'userSeenAt', input.now);
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

function lastOperatorAt(messages) {
  const found = (messages || [])
    .slice()
    .reverse()
    .find((message) => message.role === 'operator');
  return found ? Number(found.createdAt) || 0 : 0;
}

function attentionMessage(messages) {
  return (messages || [])
    .slice()
    .reverse()
    .find((message) => message.role === 'user' || message.role === 'operator');
}

function messageSummary(messages) {
  const attention = attentionMessage(messages);
  const last = messages[messages.length - 1];
  const shown = attention || last;
  return {
    preview: shown ? String(shown.text || '') : '',
    unread: Boolean(attention && attention.role === 'user'),
    attentionText: attention ? String(attention.text || '') : '',
    attentionRole: attention ? String(attention.role || '') : '',
    lastText: last ? String(last.text || '') : '',
    lastRole: last ? String(last.role || '') : '',
  };
}

function storedSummary(thread) {
  if (!thread || (!thread.attentionRole && !thread.lastRole)) {
    return null;
  }
  return {
    preview: String(thread.attentionText || thread.lastText || ''),
    unread: thread.attentionRole === 'user',
  };
}

async function latestMessagePage(db, threadId) {
  const counted = await db.collection(MESSAGES).where({ threadId }).count();
  const total = Number(counted && counted.total) || 0;
  if (!total) {
    return [];
  }
  const result = await db
    .collection(MESSAGES)
    .where({ threadId })
    .skip(Math.max(0, total - 100))
    .limit(100)
    .get();
  return (result.data || []).slice().sort(byTime('createdAt', 'asc'));
}

async function csAdminList(db, { status = 'active' } = {}) {
  // 只按状态取出再在内存排序。where 加 orderBy 需要组合索引，缺索引时云数据库直接失败，工作台会显示成没有会话。
  const statuses = status === 'active' ? ['open', 'waiting_human', 'human'] : [status];
  const rows = [];
  for (const item of statuses) {
    rows.push(...(await listWhere(db.collection(THREADS), { status: item })));
  }
  rows.sort(byTime('updatedAt', 'desc'));
  const nicknames = new Map();
  const threads = await Promise.all(rows.slice(0, 100).map(async (thread) => {
    let summary = storedSummary(thread);
    if (!summary) {
      const messages = await latestMessagePage(db, thread._id);
      const filled = messageSummary(messages);
      summary = filled;
      if (thread._id && (filled.attentionRole || filled.lastRole)) {
        await db.collection(THREADS).doc(thread._id).update({
          data: {
            attentionText: filled.attentionText,
            attentionRole: filled.attentionRole,
            lastText: filled.lastText,
            lastRole: filled.lastRole,
          },
        });
      }
    }
    const profile = await profileOf(db, thread.openid, nicknames);
    return Object.assign({}, thread, {
      preview: summary.preview,
      unread: summary.unread,
      nickname: profile.nickname,
      avatarFileId: profile.avatarFileId,
    });
  }));
  return { ok: true, threads };
}

async function csAdminGet(db, { threadId, now }) {
  let thread = await getThread(db, threadId);
  thread = await markSeen(db, thread, 'operatorSeenAt', now);
  const profile = await profileOf(db, thread.openid, new Map());
  return {
    ok: true,
    thread: Object.assign({}, thread, profile),
    messages: await getMessages(db, threadId),
  };
}

function isActiveClaim(thread, now) {
  const holder = thread && thread.replyClaimOpenid;
  if (!holder) {
    return false;
  }
  const claimedAt = Number(thread.replyClaimAt);
  if (!Number.isFinite(claimedAt)) {
    return false;
  }
  return now - claimedAt < CLAIM_WINDOW_MS;
}

function claimAvailableWhere(db, threadId, openid, now) {
  const command = db.command;
  return command.and([
    { _id: threadId },
    command.or([
      { replyClaimOpenid: command.exists(false) },
      { replyClaimOpenid: '' },
      { replyClaimAt: command.exists(false) },
      { replyClaimAt: command.lte(now - CLAIM_WINDOW_MS) },
      { replyClaimOpenid: openid },
    ]),
  ]);
}

function assertClaimableStatus(thread) {
  if (!thread || thread.status === 'closed' || !thread.status) {
    throw codedError('INVALID_STATE');
  }
}

async function csClaimReply(db, { threadId, openid, now }) {
  const thread = await getThread(db, threadId);
  assertClaimableStatus(thread);
  const result = await db.collection(THREADS).where(claimAvailableWhere(db, threadId, openid, now)).update({
    data: {
      replyClaimOpenid: openid,
      replyClaimAt: now,
    },
  });
  if (!result || !result.stats || result.stats.updated < 1) {
    throw codedError('CLAIMED');
  }
  return {
    ok: true,
    thread: Object.assign({}, thread, {
      replyClaimOpenid: openid,
      replyClaimAt: now,
    }),
  };
}

async function csReleaseReply(db, { threadId, openid, now }) {
  const thread = await getThread(db, threadId);
  if (!isActiveClaim(thread, now)) {
    return { ok: true, thread };
  }
  if (thread.replyClaimOpenid !== openid) {
    throw codedError('CLAIMED');
  }
  const result = await db
    .collection(THREADS)
    .where({ _id: threadId, replyClaimOpenid: openid })
    .update({ data: { replyClaimOpenid: '', replyClaimAt: 0 } });
  if (!result || !result.stats || result.stats.updated < 1) {
    const latest = await getThread(db, threadId);
    if (!isActiveClaim(latest, now)) {
      return { ok: true, thread: latest };
    }
    throw codedError('CLAIMED');
  }
  return {
    ok: true,
    thread: Object.assign({}, thread, { replyClaimOpenid: '', replyClaimAt: 0 }),
  };
}

async function csAdminReply(db, { threadId, openid, text, now, notifyUserFn }) {
  const body = assertUserText(text);
  if (!openid) {
    throw codedError('BAD_INPUT');
  }
  const current = await getThread(db, threadId);
  if (current.status === 'closed') {
    throw codedError('INVALID_STATE');
  }
  const refreshed = await db
    .collection(THREADS)
    .where({
      _id: threadId,
      replyClaimOpenid: openid,
      replyClaimAt: db.command.gt(now - CLAIM_WINDOW_MS),
    })
    .update({ data: { replyClaimAt: now } });
  if (!refreshed || !refreshed.stats || refreshed.stats.updated < 1) {
    throw codedError('CLAIM_REQUIRED');
  }
  const thread = await updateStatus(db, current, onOperatorFirstReply, now);
  await addMessage(db, thread, { role: 'operator', text: body }, now);
  let held = Object.assign({}, thread, { replyClaimOpenid: openid, replyClaimAt: now });
  held = await markSeen(db, held, 'operatorSeenAt', now);
  if (notifyUserFn) {
    try {
      await notifyUserFn(held);
    } catch (error) {
      console.error('cs notify user failed', error);
    }
  }
  return { ok: true, thread: held, messages: await getMessages(db, threadId) };
}

async function csAdminClose(db, { threadId, openid, now }) {
  const current = await getThread(db, threadId);
  const thread = await updateStatus(db, current, onClose, now);
  await db.collection(THREADS).doc(threadId).update({
    data: { replyClaimOpenid: '', replyClaimAt: 0 },
  });
  return {
    ok: true,
    thread: Object.assign({}, thread, { replyClaimOpenid: '', replyClaimAt: 0 }),
  };
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

function isMissingSubscriber(error) {
  const code = error && (error.errCode || error.code);
  const message = String((error && (error.errMsg || error.message)) || '');
  return (
    code === 'DATABASE_DOCUMENT_NOT_EXIST' ||
    code === 'DOCUMENT_NOT_FOUND' ||
    /document(?:\s+\w+)*\s+(?:not|does not)\s+exist/i.test(message)
  );
}

async function readSubscriberDoc(transaction, openid) {
  try {
    const result = await transaction.collection(SUBSCRIBERS).doc(openid).get();
    return (result && result.data) || null;
  } catch (error) {
    if (isMissingSubscriber(error)) {
      return null;
    }
    throw error;
  }
}

async function csRegisterNotify(db, { openid, templateId, now }) {
  assertIdentity(openid, templateId);
  const quota = await db.runTransaction(async (transaction) => {
    const current = await readSubscriberDoc(transaction, openid);
    const ref = transaction.collection(SUBSCRIBERS).doc(openid);
    if (!current) {
      await ref.set({
        data: {
          openid,
          enabled: true,
          quota: 1,
          templateId,
          lastResult: '',
          lastErrorCode: '',
          createdAt: now,
          updatedAt: now,
        },
      });
      return 1;
    }
    const nextQuota = current.templateId === templateId ? (Number(current.quota) || 0) + 1 : 1;
    await ref.update({
      data: {
        enabled: true,
        quota: nextQuota,
        templateId,
        lastResult: '',
        lastErrorCode: '',
        updatedAt: now,
      },
    });
    return nextQuota;
  });
  return { ok: true, enabled: true, quota };
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

function hasWecomUserId(record) {
  return Boolean(record && record.wecomUserId);
}

async function readWecomNotifyStatus(db, { openid }) {
  if (!openid) {
    throw codedError('BAD_INPUT');
  }
  const current = await findSubscriber(db, openid);
  if (!current) {
    return { bound: false, enabled: false };
  }
  return {
    bound: hasWecomUserId(current),
    enabled: current.enabled === true,
  };
}

async function writeWecomBinding(db, { openid, userId, now }) {
  const current = await findSubscriber(db, openid);
  const fields = {
    wecomUserId: userId,
    boundAt: now,
    enabled: true,
    updatedAt: now,
  };
  if (!current) {
    await db.collection(SUBSCRIBERS).doc(openid).set({
      data: Object.assign({ openid }, fields),
    });
  } else {
    await db.collection(SUBSCRIBERS).doc(current._id).update({ data: fields });
  }
  return { ok: true, bound: true, enabled: true };
}

async function csBindWecom(db, { openid, code, mobile, now, exchangeCode, expectedCorpId }) {
  if (!openid) {
    throw codedError('BAD_INPUT');
  }
  const phone = typeof mobile === 'string' ? mobile.trim() : '';
  if (phone) {
    if (!/^1\d{10}$/.test(phone)) {
      throw codedError('BIND_FAILED', '请填写企业微信里的11位手机号');
    }
    return writeWecomBinding(db, { openid, userId: phone, now });
  }
  if (!code) {
    throw codedError('BIND_FAILED', '企业微信没有返回登录码');
  }
  const identity = await exchangeCode(code);
  const userid = identity && identity.userid;
  const corpid = identity && identity.corpid;
  if (expectedCorpId === '') {
    throw codedError('BIND_FAILED', '云函数未配置企业 ID');
  }
  if (expectedCorpId && corpid !== expectedCorpId) {
    throw codedError('BIND_FAILED', '企业 ID 不一致');
  }
  if (!userid) {
    throw codedError('BIND_FAILED', '企业微信没有返回成员 ID');
  }
  return writeWecomBinding(db, { openid, userId: userid, now });
}

async function csSetNotify(db, { openid, enabled, now }) {
  if (!openid) {
    throw codedError('BAD_INPUT');
  }
  const current = await findSubscriber(db, openid);
  if (enabled === true) {
    if (!hasWecomUserId(current)) {
      throw codedError('UNBOUND');
    }
    await db.collection(SUBSCRIBERS).doc(current._id).update({
      data: { enabled: true, updatedAt: now },
    });
    return { ok: true, bound: true, enabled: true };
  }
  if (!current) {
    return { ok: true, bound: false, enabled: false };
  }
  await db.collection(SUBSCRIBERS).doc(current._id).update({
    data: { enabled: false },
  });
  return { ok: true, bound: hasWecomUserId(current), enabled: false };
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
  csClaimReply,
  csReleaseReply,
  CLAIM_WINDOW_MS,
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
};
