'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runTurn } = require('./runTurn');

describe('runTurn', () => {
  it('rejects an operator calling a customer profile before the model', async () => {
    let ran = false;
    const result = await runTurn({
      profileId: 'customer_service',
      actor: { type: 'operator', id: 'staff-1' },
      input: { text: '查订单' },
      requestId: 'req-1',
      executor: async () => {
        ran = true;
        return { text: '不该执行' };
      },
    });
    assert.equal(ran, false);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'FORBIDDEN');
    assert.equal(result.spans[0].name, 'gate');
    assert.equal(result.spans[0].enteredModel, false);
    assert.equal(JSON.stringify(result).includes('查订单'), false);
  });

  it('drops cards whose ids were not returned by tools', async () => {
    const result = await runTurn({
      profileId: 'video_doc',
      actor: { type: 'end_user', id: 'user-1' },
      input: { text: '这台仪器怎么校准' },
      requestId: 'req-2',
      executor: async () => ({
        text: '可以看关联商品',
        model: 'stub-model',
        tokenInput: 2,
        tokenOutput: 4,
        toolResults: [{ name: 'lookup_current_video_doc', resultCode: 'ok', cards: [{ type: 'shop_product', id: 'sku-1' }] }],
        cards: [
          { type: 'shop_product', id: 'sku-1' },
          { type: 'shop_product', id: 'sku-foreign' },
          { type: 'order', id: 'order-1' },
        ],
      }),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.cards, [{ type: 'shop_product', id: 'sku-1' }]);
    assert.equal(result.spans.some((span) => span.name === 'model'), true);
    assert.equal(JSON.stringify(result.spans).includes('这台仪器怎么校准'), false);
  });

  it('rejects an unknown profile', async () => {
    const result = await runTurn({
      profileId: 'video',
      actor: { type: 'end_user', id: 'user-1' },
      input: { text: '你好' },
      requestId: 'req-3',
      executor: async () => ({ text: '不该执行' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'BAD_INPUT');
  });
});
