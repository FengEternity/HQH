'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { planSend } = require('./csSendFlow');

describe('planSend', () => {
  it('puts claim and howto into the waiting queue without a rule reply', () => {
    const claim = planSend({
      status: 'open',
      text: '领取账号',
      faqId: 'claim',
      account: 'YD1',
      hasEscalateSystem: false,
    });
    assert.equal(claim.nextStatus, 'waiting_human');
    assert.equal(claim.notifyAdmins, true);
    assert.equal(claim.messages.some((message) => message.role === 'assistant'), false);
    assert.equal(claim.messages.some((message) => message.role === 'system'), true);

    const howto = planSend({ status: 'open', text: '怎么找视频', faqId: 'howto', hasEscalateSystem: false });
    assert.equal(howto.nextStatus, 'waiting_human');
    assert.equal(howto.notifyAdmins, true);
    assert.equal(howto.messages.some((message) => message.role === 'assistant'), false);
  });

  it('escalates free text from open and writes system once', () => {
    const first = planSend({ status: 'open', text: '全站仪坏了', hasEscalateSystem: false });
    assert.equal(first.nextStatus, 'waiting_human');
    assert.equal(first.notifyAdmins, true);
    assert.equal(first.messages.some((m) => m.role === 'system'), true);
    assert.equal(first.messages.some((m) => m.role === 'assistant'), false);

    const again = planSend({ status: 'waiting_human', text: '还有一句', hasEscalateSystem: true });
    assert.equal(again.nextStatus, 'waiting_human');
    assert.equal(again.notifyAdmins, true);
    assert.equal(again.messages.length, 1);
    assert.equal(again.messages[0].role, 'user');
  });

  it('notifies again unless an operator replied within 10 minutes', () => {
    const { QUIET_AFTER_REPLY_MS } = require('./csSendFlow');
    const now = 1_700_000_000_000;
    const recent = planSend({
      status: 'human',
      text: '还在吗',
      hasEscalateSystem: true,
      now,
      lastOperatorAt: now - QUIET_AFTER_REPLY_MS + 1,
    });
    assert.equal(recent.notifyAdmins, false);

    const quiet = planSend({
      status: 'human',
      text: '还在吗',
      hasEscalateSystem: true,
      now,
      lastOperatorAt: now - QUIET_AFTER_REPLY_MS,
    });
    assert.equal(quiet.notifyAdmins, true);
  });
});
