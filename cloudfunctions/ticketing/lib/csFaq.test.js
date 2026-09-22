'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { classifyTurn, assertUserText } = require('./csFaq');

describe('csFaq', () => {
  it('prefers faqId and maps missing/human to escalate', () => {
    assert.equal(classifyTurn({ text: 'x', faqId: 'claim' }), 'claim');
    assert.equal(classifyTurn({ text: 'x', faqId: 'howto' }), 'howto');
    assert.equal(classifyTurn({ text: 'x', faqId: 'missing' }), 'escalate');
    assert.equal(classifyTurn({ text: 'x', faqId: 'human' }), 'escalate');
  });

  it('matches typed text like the live contact page', () => {
    assert.equal(classifyTurn({ text: '领取账号' }), 'claim');
    assert.equal(classifyTurn({ text: '怎么找视频' }), 'howto');
    assert.equal(classifyTurn({ text: '没有我要的讲解' }), 'escalate');
    assert.equal(classifyTurn({ text: '转人工' }), 'escalate');
    assert.equal(classifyTurn({ text: '全站仪测不了' }), 'escalate');
  });

  it('rejects empty and overlong text', () => {
    try {
      assertUserText('  ');
      assert.fail('expected throw');
    } catch (err) {
      assert.equal(err.code, 'BAD_INPUT');
    }
    try {
      assertUserText('汉'.repeat(501));
      assert.fail('expected throw');
    } catch (err) {
      assert.equal(err.code, 'BAD_INPUT');
    }
    assert.equal(assertUserText('  ok  '), 'ok');
  });
});
