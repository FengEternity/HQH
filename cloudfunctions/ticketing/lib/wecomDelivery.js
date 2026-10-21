'use strict';

const CLAIM_WINDOW_MS = 120000;

function finishedResult(value) {
  if (value === 'sent' || value === 'skipped') {
    return value;
  }
  return '';
}

function webhookUrl(env) {
  const value = env && env.WECOM_GROUP_WEBHOOK;
  return typeof value === 'string' ? value.trim() : '';
}

async function listRecipientUserIds(db) {
  const listed = await db.collection('admin_notify_subscribers').where({ enabled: true }).get();
  const rows = listed && Array.isArray(listed.data) ? listed.data : [];
  const userIds = [];
  rows.forEach((row) => {
    const userId = row && typeof row.wecomUserId === 'string' ? row.wecomUserId.trim() : '';
    if (userId) {
      userIds.push(userId);
    }
  });
  return userIds;
}

async function readThread(db, threadId) {
  const got = await db.collection('cs_threads').doc(threadId).get();
  return got && got.data ? got.data : null;
}

async function claimThread(db, threadId, now) {
  const command = db.command;
  const result = await db.collection('cs_threads').where(command.and([
    { _id: threadId },
    command.or([
      { adminNotifyClaimedAt: command.exists(false) },
      { adminNotifyClaimedAt: command.lt(now - CLAIM_WINDOW_MS) },
    ]),
  ])).update({
    data: { adminNotifyClaimedAt: now },
  });
  return Boolean(result && result.stats && result.stats.updated > 0);
}

async function releaseClaim(db, threadId) {
  await db.collection('cs_threads').doc(threadId).update({
    data: { adminNotifyClaimedAt: db.command.remove() },
  });
}

async function writeGroup(db, threadId, now, result) {
  await db.collection('cs_threads').doc(threadId).update({
    data: {
      adminNotifyGroupAt: now,
      adminNotifyGroupResult: result,
    },
  });
}

async function writePersonal(db, threadId, now, result) {
  await db.collection('cs_threads').doc(threadId).update({
    data: {
      adminNotifyPersonalAt: now,
      adminNotifyPersonalResult: result,
    },
  });
}

function pendingResults(thread) {
  return {
    ok: true,
    group: finishedResult(thread && thread.adminNotifyGroupResult) || 'pending',
    personal: finishedResult(thread && thread.adminNotifyPersonalResult) || 'pending',
  };
}

async function deliverGroup(db, threadId, now, env, client, userIds) {
  const url = webhookUrl(env);
  if (!url) {
    await writeGroup(db, threadId, now, 'skipped');
    return 'skipped';
  }
  let result;
  try {
    result = await client.sendGroup({
      webhookUrl: url,
      userIds,
      now,
    });
  } catch {
    console.error('cs wecom group send failed');
    return 'failed';
  }
  if (result && result.errcode === 0) {
    await writeGroup(db, threadId, now, 'sent');
    return 'sent';
  }
  if (result && typeof result.errcode === 'number') {
    console.error('cs wecom group send failed', result.errcode);
  } else {
    console.error('cs wecom group send failed');
  }
  return 'failed';
}

async function deliverPersonal(db, threadId, now) {
  await writePersonal(db, threadId, now, 'skipped');
  return 'skipped';
}

async function deliverWecomAdminNotifications(db, input) {
  const threadId = input.threadId;
  const now = input.now;
  const page = input.page;
  const env = input.env;
  const client = input.client;
  const userIds = await listRecipientUserIds(db);
  if (userIds.length === 0) {
    return { ok: true, group: 'pending', personal: 'pending' };
  }

  const before = await readThread(db, threadId);
  const claimed = await claimThread(db, threadId, now);
  if (!claimed) {
    return pendingResults(before);
  }

  let groupResult = 'pending';
  let personalResult = 'pending';
  try {
    groupResult = await deliverGroup(db, threadId, now, env, client, userIds);
    personalResult = await deliverPersonal(db, threadId, now);
  } finally {
    await releaseClaim(db, threadId);
  }
  return { ok: true, group: groupResult, personal: personalResult };
}

module.exports = { deliverWecomAdminNotifications };
