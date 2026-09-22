'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  canAutoRuleReply,
  onEscalate,
  onOperatorFirstReply,
  onClose,
} = require('./csThreadState');

function codeOf(fn) {
  try {
    fn();
    return '';
  } catch (err) {
    return err.code;
  }
}

describe('csThreadState', () => {
  it('canAutoRuleReply only for open', () => {
    assert.equal(canAutoRuleReply('open'), true);
    assert.equal(canAutoRuleReply('waiting_human'), false);
    assert.equal(canAutoRuleReply('human'), false);
    assert.equal(canAutoRuleReply('closed'), false);
  });

  it('onEscalate open to waiting_human and is idempotent for waiting_human and human', () => {
    assert.equal(onEscalate('open'), 'waiting_human');
    assert.equal(onEscalate('waiting_human'), 'waiting_human');
    assert.equal(onEscalate('human'), 'human');
    assert.equal(codeOf(() => onEscalate('closed')), 'INVALID_STATE');
  });

  it('onOperatorFirstReply and onClose follow the table', () => {
    assert.equal(onOperatorFirstReply('waiting_human'), 'human');
    assert.equal(onOperatorFirstReply('human'), 'human');
    assert.equal(codeOf(() => onOperatorFirstReply('open')), 'INVALID_STATE');
    assert.equal(onClose('waiting_human'), 'closed');
    assert.equal(onClose('human'), 'closed');
    assert.equal(codeOf(() => onClose('open')), 'INVALID_STATE');
    assert.equal(codeOf(() => onClose('closed')), 'INVALID_STATE');
  });
});
