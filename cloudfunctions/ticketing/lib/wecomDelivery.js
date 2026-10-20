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

async function writePersonal(db, threadId, now) {
  await db.collection('cs_threads').doc(threadId).update({
    data: {
      adminNotifyPersonalAt: now,
      adminNotifyPersonalResult: 'sent',
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

async function deliverPersonal(db, threadId, now, page, env, client, userIds) {
  let result;
  try {
    result = await client.sendPersonal({
      userIds,
      appId: env && env.WECOM_MINI_APPID,
      page,
      now,
    });
  } catch {
    console.error('cs wecom personal send failed');
    return 'failed';
  }
  if (result && result.errcode === 0) {
    if (result.invaliduser) {
      console.error('cs wecom personal invaliduser', result.invaliduser);
    }
    await writePersonal(db, threadId, now);
    return 'sent';
  }
  if (result && typeof result.errcode === 'number') {
    console.error('cs wecom personal send failed', result.errcode);
  } else {
    console.error('cs wecom personal send failed');
  }
  return 'failed';
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
  const groupDone = finishedResult(before && before.adminNotifyGroupResult);
  const personalDone = finishedResult(before && before.adminNotifyPersonalResult);
  if (groupDone && personalDone) {
    return { ok: true, group: groupDone, personal: personalDone };
  }

  const claimed = await claimThread(db, threadId, now);
  if (!claimed) {
    return pendingResults(before);
  }

  let groupResult = groupDone;
  let personalResult = personalDone;
  try {
    if (!groupResult) {
      groupResult = await deliverGroup(db, threadId, now, env, client, userIds);
    }
    if (!personalResult) {
      personalResult = await deliverPersonal(db, threadId, now, page, env, client, userIds);
    }
  } finally {
    await releaseClaim(db, threadId);
  }
  return { ok: true, group: groupResult, personal: personalResult };
}

module.exports = { deliverWecomAdminNotifications };
