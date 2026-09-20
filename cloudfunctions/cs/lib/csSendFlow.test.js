'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { planSend } = require('./csSendFlow');

describe('planSend', () => {
  it('keeps open and replies for claim/howto without notifying admins', () => {
    const claim = planSend({
      status: 'open',
      text: '领取账号',
      faqId: 'claim',
      account: 'YD1',
      hasEscalateSystem: false,
    });
    assert.equal(claim.nextStatus, 'open');
    assert.equal(claim.notifyAdmins, false);
    assert.equal(claim.messages[0].role, 'user');
    assert.equal(claim.messages[1].role, 'assistant');
    assert.equal(claim.messages[1].meta.source, 'rule');
    assert.equal(claim.messages[1].meta.account, 'YD1');

    const howto = planSend({ status: 'open', text: '怎么找视频', faqId: 'howto', hasEscalateSystem: false });
    assert.equal(howto.nextStatus, 'open');
    assert.equal(howto.notifyAdmins, false);
    assert.equal(howto.messages[1].meta.source, 'rule');
  });

  it('escalates free text from open and writes system once', () => {
    const first = planSend({ status: 'open', text: '全站仪坏了', hasEscalateSystem: false });
    assert.equal(first.nextStatus, 'waiting_human');
    assert.equal(first.notifyAdmins, true);
    assert.equal(first.messages.some((m) => m.role === 'system'), true);
    assert.equal(first.messages.some((m) => m.role === 'assistant'), false);

    const again = planSend({ status: 'waiting_human', text: '还有一句', hasEscalateSystem: true });
    assert.equal(again.nextStatus, 'waiting_human');
    assert.equal(again.notifyAdmins, false);
    assert.equal(again.messages.length, 1);
    assert.equal(again.messages[0].role, 'user');
  });
});
