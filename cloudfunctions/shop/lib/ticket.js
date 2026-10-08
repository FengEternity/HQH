'use strict';

const crypto = require('crypto');

function signTicket(pin, exp) {
  return crypto.createHmac('sha256', pin).update(String(exp)).digest('hex');
}

function issueTicket(pin, ttlMs) {
  const exp = Date.now() + ttlMs;
  return `${exp}.${signTicket(pin, exp)}`;
}

function verifyTicket(pin, ticket) {
  if (!pin || !ticket || typeof ticket !== 'string') {
    return false;
  }
  const dot = ticket.indexOf('.');
  if (dot <= 0) {
    return false;
  }
  const exp = Number(ticket.slice(0, dot));
  const sig = ticket.slice(dot + 1);
  if (!Number.isFinite(exp) || exp < Date.now()) {
    return false;
  }
  const expected = signTicket(pin, exp);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

module.exports = { issueTicket, verifyTicket };
