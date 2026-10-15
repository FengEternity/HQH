'use strict';

function formatLocalTime(ms) {
  const d = new Date(Number(ms) + 8 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const h = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}年${mo}月${day}日 ${h}:${mi}`;
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

async function notifyNewTicket({ send, templateId, tousers, page, now }) {
  const list = tousers || [];
  if (!templateId) {
    return { ok: true, sent: 0, skipped: list.length };
  }
  return sendToUsers({
    send,
    templateId,
    tousers: list,
    page,
    data: ticketCard('待处理', now),
  });
}

async function notifyReplied({ send, templateId, touser, page, now }) {
  if (!templateId || !touser) {
    return { ok: true, sent: 0, skipped: 1 };
  }
  return sendToUsers({
    send,
    templateId,
    tousers: [touser],
    page,
    data: ticketCard('已回复', now),
  });
}

module.exports = { notifyNewTicket, notifyReplied, readNewTicketTemplateId };
