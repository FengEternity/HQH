'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readLabel } = require('./readReceipt');

describe('read receipts', () => {
  it('marks own messages read only after the other side has opened the chat', () => {
    const thread = { userSeenAt: 100, operatorSeenAt: 150 };
    assert.equal(
      readLabel({ role: 'operator', createdAt: 180 }, thread, 'operator'),
      '未读',
    );
    assert.equal(
      readLabel({ role: 'operator', createdAt: 180 }, { userSeenAt: 180 }, 'operator'),
      '已读',
    );
    assert.equal(
      readLabel({ role: 'user', createdAt: 140 }, thread, 'user'),
      '已读',
    );
    assert.equal(
      readLabel({ role: 'user', createdAt: 160 }, thread, 'user'),
      '未读',
    );
    assert.equal(
      readLabel({ role: 'operator', createdAt: 180 }, thread, 'user'),
      '',
    );
    assert.equal(
      readLabel({ role: 'assistant', createdAt: 10 }, thread, 'user'),
      '',
    );
    assert.equal(readLabel({ role: 'user', local: true }, thread, 'user'), '未读');
    const history = [
      { role: 'user', createdAt: 200 },
      { role: 'operator', createdAt: 300 },
      { role: 'user', createdAt: 400 },
    ];
    assert.equal(readLabel(history[0], {}, 'user', history), '已读');
    assert.equal(readLabel(history[1], {}, 'operator', history), '已读');
    assert.equal(readLabel(history[2], {}, 'user', history), '未读');
  });
});
