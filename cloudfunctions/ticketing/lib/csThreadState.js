'use strict';

function invalid(status) {
  const err = new Error('INVALID_STATE');
  err.code = 'INVALID_STATE';
  err.status = status;
  throw err;
}

function canAutoRuleReply(status) {
  return status === 'open';
}

function onEscalate(status) {
  if (status === 'open') {
    return 'waiting_human';
  }
  if (status === 'waiting_human' || status === 'human') {
    return status;
  }
  invalid(status);
}

function onOperatorFirstReply(status) {
  if (status === 'waiting_human') {
    return 'human';
  }
  if (status === 'human') {
    return 'human';
  }
  invalid(status);
}

function onClose(status) {
  if (status === 'waiting_human' || status === 'human') {
    return 'closed';
  }
  invalid(status);
}

module.exports = {
  STATUSES: ['open', 'waiting_human', 'human', 'closed'],
  canAutoRuleReply,
  onEscalate,
  onOperatorFirstReply,
  onClose,
};
