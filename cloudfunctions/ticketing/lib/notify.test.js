'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  notifyNewTicket,
  notifyReplied,
  readNewTicketTemplateId,
  subscribeErrorCode,
  newTicketData,
} = require('./notify');

describe('notify', () => {
  it('reads the new-ticket template id from the cloud env', () => {
    assert.equal(readNewTicketTemplateId({ CS_NEW_TICKET_TPL: ' tpl-new ' }), 'tpl-new');
    assert.equal(readNewTicketTemplateId({}), '');
  });

  it('does not send a WeChat subscribe message while that channel is paused', async () => {
    let calls = 0;
    const res = await notifyReplied({
      send: async () => {
        calls += 1;
      },
      templateId: 'tpl',
      touser: 'user-1',
      page: 'pages/contact/contact',
      now: 0,
    });
    assert.equal(calls, 0);
    assert.equal(res.sent, 0);
  });

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
      allowWhilePaused: true,
    });
    assert.equal(calls, 0);
    assert.equal(res.ok, true);
    assert.equal(res.skipped, 1);
  });

  it('sends the work-order template fields instead of thing3 and time2', async () => {
    const sent = [];
    const now = Date.parse('2026-09-20T12:34:00+08:00');
    await notifyNewTicket({
      send: async (payload) => sent.push(payload),
      templateId: 'tpl',
      tousers: ['admin-1'],
      page: 'pages/admin/inbox/inbox',
      now,
      allowWhilePaused: true,
    });
    await notifyReplied({
      send: async (payload) => sent.push(payload),
      templateId: 'tpl',
      touser: 'user-1',
      page: 'pages/contact/contact',
      now,
      allowWhilePaused: true,
    });

    const time = sent[0].data.time16.value;
    assert.equal(time, '2026年9月20日 12:34');
    assert.deepEqual(sent[0].data, {
      time16: { value: time },
      phrase17: { value: '待处理' },
      time3: { value: time },
      time13: { value: time },
      time10: { value: time },
    });
    assert.equal(sent[1].data.phrase17.value, '已回复');
    assert.equal(sent[1].data.time16.value, time);
    assert.equal(sent[1].data.time3.value, time);
  });

  it('recognizes 43101 from either errCode or errMsg', () => {
    assert.equal(subscribeErrorCode({ errCode: 43101 }), 43101);
    assert.equal(subscribeErrorCode({ errCode: '43101' }), 43101);
    assert.equal(subscribeErrorCode(new Error('errCode: 43101')), 43101);
    assert.equal(subscribeErrorCode({ errCode: 40037 }), 40037);
    assert.equal(subscribeErrorCode(new Error('quota')), 0);
  });

  it('builds the same new-ticket card used by notifyNewTicket', () => {
    const now = Date.parse('2026-09-20T12:34:00+08:00');
    assert.equal(newTicketData(now).phrase17.value, '待处理');
    assert.equal(newTicketData(now).time16.value, '2026年9月20日 12:34');
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
      allowWhilePaused: true,
    });
    assert.equal(res.ok, true);
    assert.equal(res.skipped, 1);
    assert.equal(res.sent, 0);
  });
});
