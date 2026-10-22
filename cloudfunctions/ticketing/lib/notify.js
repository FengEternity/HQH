'use strict';

const WECHAT_SUBSCRIBE_PAUSED = true;

function subscribePaused(options) {
  return WECHAT_SUBSCRIBE_PAUSED && !(options && options.allowWhilePaused === true);
}

function formatLocalTime(ms) {
  const d = new Date(Number(ms) + 8 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const h = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}年${mo}月${day}日 ${h}:${mi}`;
}

function normalizeCode(value) {
  if (value === undefined || value === null || value === '' || value === 0 || value === '0') {
    return 0;
  }
  const code = Number(value);
  return Number.isFinite(code) ? code : 0;
}

function subscribeErrorCode(error) {
  if (!error || typeof error !== 'object') {
    return 0;
  }
  const direct = error.errCode !== undefined ? error.errCode : error.errcode;
  if (normalizeCode(direct) === 43101) {
    return 43101;
  }
  const text = String(error.errMsg || error.message || '');
  if (/(?:^|\D)43101(?:\D|$)/.test(text)) {
    return 43101;
  }
  return normalizeCode(direct);
}

function newTicketData(now) {
  return ticketCard('待处理', now);
}

function ticketCard(status, now) {
  const time = formatLocalTime(now);
  return {
    time16: { value: time },
    phrase17: { value: status },
    time3: { value: time },
    time13: { value: time },
    time10: { value: time },
  };
}

async function sendToUsers({ send, templateId, tousers, page, data }) {
  let sent = 0;
  let skipped = 0;
  for (const touser of tousers) {
    try {
      await send({ touser, templateId, page, data });
      sent += 1;
    } catch (error) {
      console.error('subscribe message send failed', error);
      skipped += 1;
    }
  }
  return { ok: true, sent, skipped };
}

function readNewTicketTemplateId(env) {
  return String((env && env.CS_NEW_TICKET_TPL) || '').trim();
}

async function notifyNewTicket(options) {
  const tousers = (options && options.tousers) || [];
  if (subscribePaused(options) || !options.templateId) {
    return { ok: true, sent: 0, skipped: tousers.length };
  }
  return sendToUsers({
    send: options.send,
    templateId: options.templateId,
    tousers,
    page: options.page,
    data: ticketCard('待处理', options.now),
  });
}

async function notifyReplied(options) {
  if (subscribePaused(options) || !options.templateId || !options.touser) {
    return { ok: true, sent: 0, skipped: 1 };
  }
  return sendToUsers({
    send: options.send,
    templateId: options.templateId,
    tousers: [options.touser],
    page: options.page,
    data: ticketCard('已回复', options.now),
  });
}

module.exports = {
  notifyNewTicket,
  notifyReplied,
  readNewTicketTemplateId,
  subscribeErrorCode,
  newTicketData,
};
