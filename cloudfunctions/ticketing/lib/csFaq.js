'use strict';

const MAX_TEXT_LEN = 500;

function badInput(message) {
  const err = new Error(message);
  err.code = 'BAD_INPUT';
  throw err;
}

function assertUserText(raw) {
  const text = String(raw ?? '').trim();
  if (!text) {
    badInput('请输入内容');
  }
  if (text.length > MAX_TEXT_LEN) {
    badInput('内容太长');
  }
  return text;
}

function classifyTurn({ text, faqId }) {
  if (faqId) {
    if (faqId === 'claim' || faqId === 'howto') {
      return faqId;
    }
    if (faqId === 'missing' || faqId === 'human') {
      return 'escalate';
    }
  }
  const q = String(text || '').trim();
  if (/账号|领取/.test(q)) {
    return 'claim';
  }
  if (/没有|缺|找不到|完善|问题库/.test(q)) {
    return 'escalate';
  }
  if (/怎么找|搜索|视频/.test(q)) {
    return 'howto';
  }
  if (/人工|微信|电话|联系/.test(q)) {
    return 'escalate';
  }
  return 'escalate';
}

module.exports = { MAX_TEXT_LEN, assertUserText, classifyTurn };
