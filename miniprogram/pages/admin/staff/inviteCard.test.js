'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { drawInviteCard, inviteCaption, QR_SIZE } = require('./inviteCard');

describe('invite card caption', () => {
  it('prints the China deadline and a 24-hour label below the QR', () => {
    const caption = inviteCaption(Date.parse('2026-10-24T03:17:00.000Z'));
    const calls = [];
    const ctx = {
      fillRect() {},
      drawImage() {},
      fillText(...args) {
        calls.push(args);
      },
    };

    drawInviteCard(ctx, { image: { src: 'qr' }, caption });

    assert.deepEqual(
      calls.map((args) => args[0]),
      ['2026-10-24 11:17', '24 小时有效'],
    );
    assert.ok(calls.every((args) => args[2] > QR_SIZE));
  });

  it('rejects an invite that has no deadline', () => {
    assert.throws(() => inviteCaption(undefined), /缺少有效期/);
  });
});
