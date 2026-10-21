'use strict';

const cloud = require('wx-server-sdk');
const {
  csHistory,
  csSend,
  csEscalate,
  csAdminList,
  csAdminGet,
  csAdminReply,
  csAdminClose,
  csClaimReply,
  csReleaseReply,
  csRegisterNotify,
  csUnregisterNotify,
  readWecomNotifyStatus,
  csBindWecom,
  csBindProfile,
  csGetProfile,
  csSetNotify,
} = require('./lib/csStore');
const { notifyReplied, readNewTicketTemplateId } = require('./lib/notify');
const { verifyTicket } = require('./lib/ticket');
const { createWecomClient } = require('./lib/wecomClient');
const { deliverWecomAdminNotifications } = require('./lib/wecomDelivery');
const { handleWecomCallback } = require('./lib/wecomCallback');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const wecomClient = createWecomClient({
  env: process.env,
  now: () => Date.now(),
});

const ERROR_MESSAGES = {
  INVALID_STATE: '当前状态不支持此操作，请刷新后重试',
  FORBIDDEN: '无权访问该会话',
  NOT_FOUND: '会话不存在',
  BAD_INPUT: '输入内容不正确',
  BIND_FAILED: '绑定失败',
  UNBOUND: '请先绑定企业微信',
  UNAUTHORIZED: '登录已失效，请重新登录',
  UNKNOWN_ACTION: '不支持的操作',
  CLAIMED: '同事正在回复',
  CLAIM_REQUIRED: '请先持有会话',
};

function codedError(code, message) {
  const error = new Error(message || ERROR_MESSAGES[code] || '请求失败');
  error.code = code;
  return error;
}

function requireAdmin(ticket) {
  if (!verifyTicket(process.env.ADMIN_PIN, ticket)) {
    throw codedError('UNAUTHORIZED');
  }
}

async function checkText(content) {
  if (process.env.SKIP_CONTENT_CHECK === '1') {
    return;
  }
  const text = String(content || '').trim();
  if (!text) {
    return;
  }
  const wxContext = cloud.getWXContext();
  const result = await cloud.openapi.security.msgSecCheck({
    openid: wxContext.OPENID,
    scene: 1,
    version: 2,
    content: text,
  });
  const suggest = result && result.result && result.result.suggest;
  if (result.errCode && result.errCode !== 0) {
    throw codedError('CONTENT_REJECTED', '内容安全校验失败');
  }
  if (suggest && suggest !== 'pass') {
    throw codedError('CONTENT_REJECTED', '文案未通过内容安全检测，请修改后重发');
  }
}

function sendSubscribeMessage(payload) {
  return cloud.openapi.subscribeMessage.send(payload);
}

function notifyAdmins(now, thread) {
  const threadId = thread && thread._id;
  return deliverWecomAdminNotifications(db, {
    threadId,
    now,
    page: 'pages/admin/ticket/ticket?id=' + threadId,
    env: {
      WECOM_GROUP_WEBHOOK: process.env.WECOM_GROUP_WEBHOOK,
      WECOM_MINI_APPID: process.env.WECOM_MINI_APPID,
    },
    client: wecomClient,
  });
}

function notifyUser(openid, now) {
  return notifyReplied({
    send: sendSubscribeMessage,
    templateId: process.env.CS_REPLIED_TPL,
    touser: openid,
    page: 'pages/contact/contact',
    now,
  });
}

async function dispatch(event) {
  const action = event && event.action;
  const now = Date.now();
  const openid = cloud.getWXContext().OPENID || '';
  switch (action) {
    case 'csHistory':
      return csHistory(db, { openid, now });
    case 'csSend':
      await checkText(event.text);
      return csSend(db, {
        openid,
        threadId: event.threadId,
        text: event.text,
        faqId: event.faqId,
        account: event.account,
        wechatId: process.env.CS_WECHAT_ID || '',
        phone: process.env.CS_PHONE || '',
        now,
        notifyAdminsFn: (thread) => notifyAdmins(now, thread),
      });
    case 'csEscalate': {
      const text = event.text || '转人工';
      await checkText(text);
      return csEscalate(db, {
        openid,
        threadId: event.threadId,
        text,
        wechatId: process.env.CS_WECHAT_ID || '',
        phone: process.env.CS_PHONE || '',
        now,
        notifyAdminsFn: (thread) => notifyAdmins(now, thread),
      });
    }
    case 'csAdminList':
      requireAdmin(event.ticket);
      return csAdminList(db, { status: event.status, now });
    case 'csAdminGet':
      requireAdmin(event.ticket);
      return Object.assign({}, await csAdminGet(db, { threadId: event.threadId, now }), {
        viewerOpenid: openid,
      });
    case 'csAdminReply':
      requireAdmin(event.ticket);
      await checkText(event.text);
      return csAdminReply(db, {
        threadId: event.threadId,
        openid,
        text: event.text,
        now,
        notifyUserFn: (thread) => notifyUser(thread.openid, now),
      });
    case 'csAdminClose':
      requireAdmin(event.ticket);
      return csAdminClose(db, { threadId: event.threadId, openid, now });
    case 'csClaimReply':
      requireAdmin(event.ticket);
      return csClaimReply(db, { threadId: event.threadId, openid, now });
    case 'csReleaseReply':
      requireAdmin(event.ticket);
      return csReleaseReply(db, { threadId: event.threadId, openid, now });
    case 'csRegisterNotify':
      requireAdmin(event.ticket);
      return csRegisterNotify(db, {
        openid,
        templateId: readNewTicketTemplateId(process.env),
        now,
      });
    case 'csUnregisterNotify':
      requireAdmin(event.ticket);
      return csUnregisterNotify(db, { openid, now });
    case 'csGetProfile':
      return csGetProfile(db, { openid });
    case 'csBindProfile':
      await checkText(event.nickname);
      return csBindProfile(db, {
        openid,
        nickname: event.nickname,
        avatarFileId: event.avatarFileId,
        now,
      });
    case 'csBindWecom':
      requireAdmin(event.ticket);
      return csBindWecom(db, {
        openid,
        code: event.code,
        mobile: event.mobile,
        now,
        expectedCorpId: process.env.WECOM_CORP_ID || '',
        exchangeCode: (code) => wecomClient.exchangeCode(code),
      });
    case 'csSetNotify':
      requireAdmin(event.ticket);
      return csSetNotify(db, { openid, enabled: event.enabled === true, now });
    case 'csNotifyConfig':
      requireAdmin(event.ticket);
      return Object.assign({ ok: true }, await readWecomNotifyStatus(db, { openid }));
    default:
      throw codedError('UNKNOWN_ACTION');
  }
}

exports.main = async (event) => {
  if (event && typeof event.httpMethod === 'string') {
    return handleWecomCallback(event, process.env);
  }
  try {
    return await dispatch(event);
  } catch (error) {
    return {
      ok: false,
      code: error.code || 'FAIL',
      message: error.message || 'FAIL',
    };
  }
};

module.exports.checkText = checkText;
