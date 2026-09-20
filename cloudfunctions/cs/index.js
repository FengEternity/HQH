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
  csRegisterNotify,
} = require('./lib/csStore');
const { notifyNewTicket, notifyReplied } = require('./lib/notify');
const { verifyTicket } = require('./lib/ticket');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

function codedError(code, message = code) {
  const error = new Error(message);
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
    throw codedError('CONTENT_REJECTED', '文案未通过内容安全检测，请修改后上架');
  }
}

function sendSubscribeMessage(payload) {
  return cloud.openapi.subscribeMessage.send(payload);
}

async function notifyAdmins(now) {
  const result = await db.collection('admin_notify_subscribers').limit(100).get();
  return notifyNewTicket({
    send: sendSubscribeMessage,
    templateId: process.env.CS_NEW_TICKET_TPL,
    tousers: (result.data || []).map((item) => item.openid).filter(Boolean),
    page: 'pages/admin/inbox/inbox',
    now,
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
        notifyAdminsFn: () => notifyAdmins(now),
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
        notifyAdminsFn: () => notifyAdmins(now),
      });
    }
    case 'csAdminList':
      requireAdmin(event.ticket);
      return csAdminList(db, { status: event.status, now });
    case 'csAdminGet':
      requireAdmin(event.ticket);
      return csAdminGet(db, { threadId: event.threadId });
    case 'csAdminReply':
      requireAdmin(event.ticket);
      await checkText(event.text);
      return csAdminReply(db, {
        threadId: event.threadId,
        text: event.text,
        now,
        notifyUserFn: (thread) => notifyUser(thread.openid, now),
      });
    case 'csAdminClose':
      requireAdmin(event.ticket);
      return csAdminClose(db, { threadId: event.threadId, now });
    case 'csRegisterNotify':
      requireAdmin(event.ticket);
      return csRegisterNotify(db, { openid, now });
    default:
      throw codedError('UNKNOWN_ACTION');
  }
}

exports.main = async (event) => {
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
