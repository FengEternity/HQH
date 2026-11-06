'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { verifyServiceProof } = require('./ai-runtime');
const { PURPOSE, INTRO_TRANSCRIPT_LIMIT, requestIntro } = require('./requestIntro');

describe('requestIntro', () => {
  it('用服务签名把标题和口播交给云函数，不在容器里调用模型', async () => {
    let payload;
    const intro = await requestIntro({
      pin: 'pin',
      title: '整平',
      brandName: '千寻',
      transcript: '先打开项目。',
      terms: ['RTK'],
      now: 1793700000000,
      app: {
        async callFunction(request) {
          payload = request;
          return { result: { ok: true, intro: '千寻本期讲解整平。' } };
        },
      },
    });
    assert.equal(intro, '千寻本期讲解整平。');
    assert.equal(payload.name, 'agent');
    assert.equal(payload.data.action, 'writeVideoIntro');
    assert.equal(payload.data.transcript, '先打开项目。');
    assert.equal(verifyServiceProof('pin', PURPOSE, payload.data.proof, 1793700000000), true);
    assert.equal(JSON.stringify(payload).includes('TCB_API_KEY'), false);
    let longPayload;
    await requestIntro({
      pin: 'pin',
      transcript: '口'.repeat(INTRO_TRANSCRIPT_LIMIT + 20),
      now: 1793700000000,
      app: {
        async callFunction(request) {
          longPayload = request;
          return { result: { ok: true, intro: '简介' } };
        },
      },
    });
    assert.equal([...longPayload.data.transcript].length, INTRO_TRANSCRIPT_LIMIT);
  });

  it('没有口令或云函数没有写出简介时失败', async () => {
    await assert.rejects(() => requestIntro({ app: { callFunction() { throw new Error('不应调用'); } } }), /NOT_CONFIGURED/);
    await assert.rejects(
      () => requestIntro({
        pin: 'pin',
        transcript: '口播',
        app: { async callFunction() { return { result: { ok: false, code: 'UNAUTHORIZED' } }; } },
      }),
      (error) => error.code === 'UNAUTHORIZED',
    );
  });
});
