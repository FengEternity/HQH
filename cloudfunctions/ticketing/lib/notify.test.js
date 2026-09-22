'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { notifyNewTicket, notifyReplied } = require('./notify');

describe('notify', () => {
  it('skips when template id is missing', async () => {
    let calls = 0;
    const send = async () => {
      calls += 1;
    };
    const res = await notifyNewTicket({
      send,
      templateId: '',
      tousers: ['a'],
      page: 'pages/admin/inbox/inbox',
      now: Date.parse('2026-09-20T12:00:00+08:00'),
    });
    assert.equal(calls, 0);
    assert.equal(res.ok, true);
    assert.equal(res.skipped, 1);
  });

  it('keeps ok when send throws', async () => {
    const send = async () => {
      throw new Error('quota');
    };
    const res = await notifyReplied({
      send,
      templateId: 'tpl',
      touser: 'user1',
      page: 'pages/contact/contact',
      now: 0,
    });
    assert.equal(res.ok, true);
    assert.equal(res.skipped, 1);
    assert.equal(res.sent, 0);
  });
});
