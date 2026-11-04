'use strict';

const cloud = require('wx-server-sdk');
const { handleAgentEvent } = require('./lib/videoDocHandler');
const { loadVideoDoc, loadLinkedVideoProducts } = require('./lib/videoDocPorts');
const { ensureAgentCollections } = require('./lib/ensureAgentCollections');
const { exportForsetiTrace } = require('./lib/forsetiTrace');
const { createVideoDocExecutor } = require('./lib/videoDocModel');
const { handleAgentModelAction, loadPlaceModelName } = require('./lib/agentModelAction');
const { createProbeProof } = require('./lib/ai-runtime');

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

async function probeVideoIntro() {
  if (!process.env.ADMIN_PIN) {
    const error = new Error('NOT_CONFIGURED');
    error.code = 'MODEL_UNAVAILABLE';
    error.publicMessage = '视频处理服务校验尚未配置，请完成服务端接入设置';
    throw error;
  }
  const response = await cloud.callContainer({ path: '/ai/probe', method: 'POST',
    header: { 'X-WX-SERVICE': 'video-ingest', 'X-HQH-AI-Proof': createProbeProof(process.env.ADMIN_PIN) }, data: {} });
  let body;
  try { body = typeof response.data === 'string' ? JSON.parse(response.data) : response.data; } catch { body = null; }
  if (!body || !body.ok || typeof body.text !== 'string') {
    const error = new Error('MODEL_UNAVAILABLE');
    error.code = 'MODEL_UNAVAILABLE';
    error.publicMessage = body && body.code === 'NOT_CONFIGURED'
      ? '视频处理服务尚未配置，请完成服务端接入设置'
      : '视频处理服务暂时无法调用，请检查部署与接入设置';
    throw error;
  }
  return body;
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
        probeVideoIntro,
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
