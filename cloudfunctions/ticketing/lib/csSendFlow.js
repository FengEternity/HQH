'use strict';

const { canAutoRuleReply, onEscalate } = require('./csThreadState');
const { assertUserText, classifyTurn } = require('./csFaq');
const { faqs, escalatedText } = require('./contactCopy');

function faqById(id) {
  return faqs.find((item) => item.id === id);
}

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

function planSend(input) {
  const text = assertUserText(input.text);
  const kind = classifyTurn({ text, faqId: input.faqId });
  const userMsg = { role: 'user', text };
  if (canAutoRuleReply(input.status) && (kind === 'claim' || kind === 'howto')) {
    const faq = faqById(kind);
    const assistant = {
      role: 'assistant',
      text: faq.answer,
      meta: { source: 'rule' },
    };
    if (kind === 'claim') {
      assistant.meta.account = String(input.account || '');
      assistant.meta.actions = [{ id: 'copyAccount', label: '复制账号' }];
      assistant.text =
        '这是你的资料馆账号，点复制带走。回来搜型号、补充问题时把账号一并告诉我。';
    }
    return {
      nextStatus: 'open',
      notifyAdmins: false,
      messages: [userMsg, assistant],
    };
  }
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
    notifyAdmins: input.status === 'open',
    messages,
  };
}

module.exports = { planSend, systemEscalateBody };
