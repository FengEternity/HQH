'use strict';

const ADMIN_USERS = 'admin_users';
const ADMIN_INVITES = 'admin_invites';
const ADMIN_CONFIG = 'admin_config';
const STAFF_CONFIG_ID = 'staff';
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const ROLES = new Set(['admin', 'operator']);

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isMissingDocumentError(error) {
  const code = error && (error.errCode || error.code);
  const message = String((error && (error.errMsg || error.message)) || '');
  return (
    code === -502005 ||
    code === 'DATABASE_COLLECTION_NOT_EXIST' ||
    /not exist|not found|missing document/i.test(message)
  );
}

async function getDocument(container, collectionName, id) {
  try {
    const result = await container.collection(collectionName).doc(id).get();
    return result && result.data ? result.data : null;
  } catch (error) {
    if (isMissingDocumentError(error)) {
      return null;
    }
    throw error;
  }
}

function assertRole(role) {
  if (!ROLES.has(role)) {
    throw domainError('INVALID_ROLE', '无效的人员角色');
  }
}

async function getAdminState(db, openid) {
  const [config, record] = await Promise.all([
    getDocument(db, ADMIN_CONFIG, STAFF_CONFIG_ID),
    openid ? getDocument(db, ADMIN_USERS, openid) : Promise.resolve(null),
  ]);
  return {
    initialized: Boolean(config && config.initialized),
    enabled: Boolean(record && record.enabled),
    role: record && record.role ? record.role : '',
  };
}

async function requireStaff(db, openid) {
  const record = openid ? await getDocument(db, ADMIN_USERS, openid) : null;
  if (!record || !record.enabled) {
    throw domainError('UNAUTHORIZED', '未授权');
  }
  return record;
}

async function requireAdminRole(db, openid) {
  const record = await requireStaff(db, openid);
  if (record.role !== 'admin') {
    throw domainError('FORBIDDEN', '只有管理员能修改人员');
  }
  return record;
}

async function bootstrapAdmin(db, { openid, pin, expectedPin, now }) {
  return await db.runTransaction(async (transaction) => {
    const config = await getDocument(transaction, ADMIN_CONFIG, STAFF_CONFIG_ID);
    if (config && config.initialized) {
      throw domainError('ALREADY_INITIALIZED', '初始化已完成');
    }
    if (!openid || !expectedPin || pin !== expectedPin) {
      throw domainError('INVALID_PIN', '口令不正确');
    }

    const record = {
      openid,
      role: 'admin',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    await transaction.collection(ADMIN_USERS).doc(openid).set({ data: record });
    await transaction.collection(ADMIN_CONFIG).doc(STAFF_CONFIG_ID).set({
      data: {
        initialized: true,
        initializedAt: now,
        initializedBy: openid,
      },
    });
    return record;
  });
}

function staffRank(record) {
  if (!record.enabled) {
    return 2;
  }
  return record.role === 'admin' ? 0 : 1;
}

async function listStaff(db, { openid }) {
  await requireAdminRole(db, openid);
  const result = await db.collection(ADMIN_USERS).get();
  const records = (result && result.data ? result.data : []).slice();
  records.sort((left, right) => {
    const rankDifference = staffRank(left) - staffRank(right);
    if (rankDifference !== 0) {
      return rankDifference;
    }
    return (left.createdAt || 0) - (right.createdAt || 0);
  });
  return records;
}

async function updateStaff(db, { openid, targetOpenid, role, enabled, now }) {
  await requireAdminRole(db, openid);
  if (openid === targetOpenid) {
    throw domainError('CANNOT_EDIT_SELF', '不能修改自己');
  }
  assertRole(role);

  return await db.runTransaction(async (transaction) => {
    const target = await getDocument(transaction, ADMIN_USERS, targetOpenid);
    if (!target) {
      throw domainError('STAFF_NOT_FOUND', '人员不存在');
    }

    const removesEnabledAdmin =
      target.enabled &&
      target.role === 'admin' &&
      (!enabled || role !== 'admin');
    if (removesEnabledAdmin) {
      const countResult = await transaction
        .collection(ADMIN_USERS)
        .where({ role: 'admin', enabled: true })
        .count();
      if (!countResult || countResult.total <= 1) {
        throw domainError('LAST_ADMIN', '至少保留一名管理员');
      }
    }

    const changes = { role, enabled: Boolean(enabled), updatedAt: now };
    await transaction.collection(ADMIN_USERS).doc(targetOpenid).update({
      data: changes,
    });
    return { ...target, ...changes };
  });
}

async function createInvite(db, { openid, role, code, now }) {
  await requireAdminRole(db, openid);
  assertRole(role);
  const invite = {
    code,
    role,
    createdBy: openid,
    createdAt: now,
    expiresAt: now + INVITE_TTL_MS,
    usedBy: '',
  };
  await db.collection(ADMIN_INVITES).doc(code).set({ data: invite });
  return invite;
}

async function claimInvite(db, { openid, code, now }) {
  return await db.runTransaction(async (transaction) => {
    const invite = await getDocument(transaction, ADMIN_INVITES, code);
    if (
      !invite ||
      invite.usedBy ||
      typeof invite.expiresAt !== 'number' ||
      invite.expiresAt <= now ||
      !ROLES.has(invite.role)
    ) {
      throw domainError('INVALID_INVITE', '邀请无效');
    }

    const existing = openid
      ? await getDocument(transaction, ADMIN_USERS, openid)
      : null;
    if (existing && existing.enabled) {
      throw domainError('ALREADY_STAFF', '你已在名单中');
    }
    if (existing) {
      throw domainError('STAFF_DISABLED', '需要管理员重新启用');
    }
    if (!openid) {
      throw domainError('INVALID_INVITE', '邀请无效');
    }

    const record = {
      openid,
      role: invite.role,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    await transaction.collection(ADMIN_USERS).doc(openid).set({ data: record });
    await transaction.collection(ADMIN_INVITES).doc(code).update({
      data: { usedBy: openid },
    });
    return record;
  });
}

module.exports = {
  getAdminState,
  requireStaff,
  requireAdminRole,
  bootstrapAdmin,
  listStaff,
  updateStaff,
  createInvite,
  claimInvite,
};
