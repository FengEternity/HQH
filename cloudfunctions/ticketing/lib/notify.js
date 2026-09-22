'use strict';

function formatLocalTime(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${day} ${h}:${mi}`;
}

async function sendToUsers({ send, templateId, tousers, page, data }) {
  let sent = 0;
  let skipped = 0;
  for (const touser of tousers) {
    try {
      await send({ touser, templateId, page, data });
      sent += 1;
    } catch {
      skipped += 1;
    }
  }
  return { ok: true, sent, skipped };
}

async function notifyNewTicket({ send, templateId, tousers, page, now }) {
  const list = tousers || [];
  if (!templateId) {
    return { ok: true, sent: 0, skipped: list.length };
  }
  const data = {
    thing3: { value: '待处理工单' },
    time2: { value: formatLocalTime(now) },
  };
  return sendToUsers({ send, templateId, tousers: list, page, data });
}

async function notifyReplied({ send, templateId, touser, page, now }) {
  if (!templateId || !touser) {
    return { ok: true, sent: 0, skipped: 1 };
  }
  const data = {
    thing3: { value: '客服已回复' },
    time2: { value: formatLocalTime(now) },
  };
  return sendToUsers({
    send,
    templateId,
    tousers: [touser],
    page,
    data,
  });
}

module.exports = { notifyNewTicket, notifyReplied };
