'use strict';

function readLabel(message, thread, ownRole, messages) {
  if (!message || (message.role !== 'user' && message.role !== 'operator') || message.role !== ownRole) {
    return '';
  }
  if (message.local || !Number.isFinite(Number(message.createdAt))) {
    return '未读';
  }
  const otherRole = ownRole === 'user' ? 'operator' : 'user';
  const raw = ownRole === 'user' ? thread && thread.operatorSeenAt : thread && thread.userSeenAt;
  let seenAt = Number(raw);
  if (!Number.isFinite(seenAt)) {
    seenAt = 0;
  }
  (messages || []).forEach((item) => {
    if (!item || item.local || item.role !== otherRole) {
      return;
    }
    const at = Number(item.createdAt);
    if (Number.isFinite(at) && at > seenAt) {
      seenAt = at;
    }
  });
  return seenAt >= Number(message.createdAt) ? '已读' : '未读';
}

module.exports = { readLabel };
