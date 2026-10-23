'use strict';

const cloud = require('wx-server-sdk');
const { handleAgentEvent } = require('./lib/videoDocHandler');
const { loadVideoDoc, loadLinkedVideoProducts } = require('./lib/videoDocPorts');
const { ensureAgentCollections } = require('./lib/ensureAgentCollections');
const { exportForsetiTrace } = require('./lib/forsetiTrace');
const { createVideoDocExecutor } = require('./lib/videoDocModel');
const { handleAgentModelAction, loadPlaceModelName } = require('./lib/agentModelAction');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, timeout: 60000 });
const db = cloud.database();

async function checkText(content) {
  if (process.env.SKIP_CONTENT_CHECK === '1') return;
  const text = String(content || '').trim();
  if (!text) return;
  const wxContext = cloud.getWXContext();
  const result = await cloud.openapi.security.msgSecCheck({
    openid: wxContext.OPENID,
    scene: 1,
    version: 2,
    content: text,
  });
  const suggest = result && result.result && result.result.suggest;
  if ((result && result.errCode && result.errCode !== 0) || (suggest && suggest !== 'pass')) {
    const error = new Error('文案未通过内容安全检测，请修改后重发');
    error.code = 'CONTENT_REJECTED';
    throw error;
  }
}

async function exportTrace(turn) {
  const result = await exportForsetiTrace({
    publicKey: process.env.FORSETI_PUBLIC_KEY,
    secretKey: process.env.FORSETI_SECRET_KEY,
    turn,
    transport: (payload) => cloud.callContainer(payload),
  });
  if (result && result.ok === false && result.code !== 'NO_CREDENTIALS') {
    console.error('forseti export failed', result.code);
  }
}

function createAi() {
  if (typeof cloud.ai !== 'function') return null;
  try {
    return cloud.ai();
  } catch (error) {
    return null;
  }
}

exports.main = async (event) => {
  try {
    const openid = cloud.getWXContext().OPENID;
    const action = event && event.action;
    if (action === 'agentModelConfig' || action === 'agentModelSave' || action === 'agentModelTest') {
      return await handleAgentModelAction(db, event, {
        openid,
        env: process.env,
        now: Date.now(),
        createAi,
      });
    }
    if (event && (event.action === 'videoDocSend' || event.action === 'videoDocHistory')) {
      await ensureAgentCollections(db);
    }
    return await handleAgentEvent(db, event, {
      openid,
      now: Date.now(),
      loadVideo: (id) => loadVideoDoc(db, id),
      loadLinkedProducts: (id) => loadLinkedVideoProducts(db, id),
      checkContent: checkText,
      executor: createVideoDocExecutor({
        env: process.env,
        createAi,
        loadModelName: () => loadPlaceModelName(db, 'video_doc', process.env),
      }),
      exportTrace,
    });
  } catch (error) {
    const code = error && (error.errCode || error.code);
    const detail = String((error && (error.errMsg || error.message)) || '').slice(0, 200);
    console.error('agent failed', code || '', detail);
    const suffix = code !== undefined && code !== null && String(code).length <= 40 ? ' ' + code : '';
    return { ok: false, code: 'INTERNAL', message: '请求失败' + suffix };
  }
};
