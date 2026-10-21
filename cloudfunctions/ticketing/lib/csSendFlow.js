'use strict';

const { onEscalate } = require('./csThreadState');
const { assertUserText } = require('./csFaq');
const { escalatedText } = require('./contactCopy');

const QUIET_AFTER_REPLY_MS = 600000;

function systemEscalateBody(wechatId, phone) {
  let body = escalatedText;
  if (wechatId) {
    body += '\n客服微信：' + wechatId;
  }
  if (phone) {
    body += '\n客服电话：' + phone;
  }
  return body;
}

function shouldNotifyAdmins(input) {
  const at = Number(input && input.lastOperatorAt);
  const now = Number(input && input.now);
  if (!Number.isFinite(at) || at <= 0 || !Number.isFinite(now)) {
    return true;
  }
  return now - at >= QUIET_AFTER_REPLY_MS;
}

function planSend(input) {
  const text = assertUserText(input.text);
  const userMsg = { role: 'user', text };
  const nextStatus = onEscalate(input.status);
  const messages = [userMsg];
  if (!input.hasEscalateSystem) {
    messages.push({
      role: 'system',
      text: systemEscalateBody(input.wechatId, input.phone),
      meta: { event: 'escalated' },
    });
  }
  return {
    nextStatus,
    notifyAdmins: shouldNotifyAdmins(input),
    messages,
  };
}

module.exports = { planSend, shouldNotifyAdmins, systemEscalateBody, QUIET_AFTER_REPLY_MS };
