'use strict';

const { assignmentPatch, publicModelConfig, resolvePlaceModel } = require('./agentModels');
const { probeAgentModel } = require('./videoDocModel');

const ADMIN_USERS = 'admin_users';
const ADMIN_CONFIG = 'admin_config';
const CONFIG_ID = 'agent_models';

function isMissingDocumentError(error) {
  const code = error && (error.errCode || error.code);
  const message = String((error && (error.errMsg || error.message)) || '');
  return (
    code === -502005 ||
    code === 'DATABASE_COLLECTION_NOT_EXIST' ||
    /not exist|not found|missing document/i.test(message)
  );
}

async function getDocument(db, collectionName, id) {
  if (!id) return null;
  try {
    const result = await db.collection(collectionName).doc(id).get();
    const data = result && result.data;
    if (Array.isArray(data)) return data.length ? data[0] : null;
    return data || null;
  } catch (error) {
    if (isMissingDocumentError(error)) return null;
    throw error;
  }
}

async function requireStaff(db, openid) {
  const record = await getDocument(db, ADMIN_USERS, openid);
  if (!record || !record.enabled) {
    const error = new Error('未授权');
    error.code = 'UNAUTHORIZED';
    throw error;
  }
  return record;
}

function denied() {
  return { ok: false, code: 'UNAUTHORIZED', message: '未授权' };
}

async function loadPlaceModelName(db, place, env) {
  try {
    const stored = await getDocument(db, ADMIN_CONFIG, CONFIG_ID);
    return resolvePlaceModel({ place, stored, env });
  } catch (error) {
    return resolvePlaceModel({ place, stored: null, env });
  }
}

async function handleAgentModelAction(db, event, deps) {
  try {
    await requireStaff(db, deps && deps.openid);
  } catch (error) {
    return denied();
  }
  const action = event && event.action;
  const env = (deps && deps.env) || {};
  if (action === 'agentModelConfig') {
    const stored = await getDocument(db, ADMIN_CONFIG, CONFIG_ID);
    return { ok: true, ...publicModelConfig(stored, env) };
  }
  if (action === 'agentModelSave') {
    let patch;
    try {
      const current = await getDocument(db, ADMIN_CONFIG, CONFIG_ID);
      patch = assignmentPatch(current, event.place, event.model);
    } catch (error) {
      return { ok: false, code: 'BAD_INPUT', message: '请选择列表中的模型' };
    }
    await db.collection(ADMIN_CONFIG).doc(CONFIG_ID).set({
      data: Object.assign({}, patch, { updatedAt: deps && deps.now }),
    });
    return { ok: true, ...publicModelConfig(patch, env) };
  }
  if (action === 'agentModelTest') {
    try {
      const result = await probeAgentModel({
        modelName: event && event.model,
        createAi: deps && deps.createAi,
      });
      return { ok: true, model: result.model, text: result.text, message: '可以调用' };
    } catch (error) {
      if (error && error.code === 'BAD_INPUT') {
        return { ok: false, code: 'BAD_INPUT', message: '请选择列表中的模型' };
      }
      if (error && error.code === 'TIMEOUT') {
        return { ok: false, code: 'TIMEOUT', message: '调用超时，请再试一次' };
      }
      return {
        ok: false,
        code: 'MODEL_UNAVAILABLE',
        message: (error && error.publicMessage) || '暂时无法调用，请稍后再试',
      };
    }
  }
  return { ok: false, code: 'UNKNOWN_ACTION', message: '不支持的操作' };
}

module.exports = { handleAgentModelAction, loadPlaceModelName };
