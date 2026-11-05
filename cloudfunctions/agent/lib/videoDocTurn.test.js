'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runVideoDocTurn } = require('./videoDocTurn');

function publishedVideo(extra) {
  return Object.assign(
    {
      status: 'published',
      title: '全站仪设站',
      intro: '先整平再对中',
      tags: ['设站'],
      brandName: '华测',
      modelName: 'i90',
      transcript: '口播正文',
    },
    extra,
  );
}

describe('runVideoDocTurn', () => {
  it('answers only the bound published video and drops unpublished products', async () => {
    const loaded = [];
    const result = await runVideoDocTurn({
      videoId: 'vid-1',
      actor: { type: 'end_user', id: 'user-1' },
      text: '怎么整平',
      requestId: 'req-video-1',
      currentTimeSec: 12,
      loadVideo: async (id) => {
        loaded.push(id);
        return publishedVideo();
      },
      loadLinkedProducts: async (id) => {
        loaded.push('products:' + id);
        return [
          { id: 'sku-1', name: '脚架', priceFen: 100, status: 'published' },
          { id: 'sku-2', name: '草稿货', priceFen: 200, status: 'draft' },
        ];
      },
      executor: async ({ tools, projection }) => {
        assert.equal(projection.playbackLabel, '约第 12 秒');
        const doc = await tools.lookup_current_video_doc({ videoId: 'vid-other' });
        assert.equal(doc.title, '全站仪设站');
        assert.deepEqual(
          doc.products.map((item) => item.id),
          ['sku-1'],
        );
        return {
          text: '先整平',
          model: 'stub',
          tokenInput: 1,
          tokenOutput: 1,
          toolResults: [
            {
              name: 'lookup_current_video_doc',
              resultCode: 'ok',
              cards: doc.products.map((item) => ({ type: 'shop_product', id: item.id })),
            },
          ],
          cards: [{ type: 'shop_product', id: 'sku-1' }],
        };
      },
    });

    assert.deepEqual(loaded, ['vid-1', 'products:vid-1']);
    assert.equal(result.ok, true);
    assert.equal(result.profileId, 'video_doc');
    assert.equal(result.text, '先整平');
    assert.deepEqual(result.cards, [{ type: 'shop_product', id: 'sku-1' }]);
  });

  it('does not call the model or return draft copy when the video is not published', async () => {
    let ran = false;
    const result = await runVideoDocTurn({
      videoId: 'vid-draft',
      actor: { type: 'end_user', id: 'user-1' },
      text: '简介是什么',
      requestId: 'req-video-2',
      loadVideo: async () => ({ status: 'draft', intro: '机密草稿', title: '未发布' }),
      loadLinkedProducts: async () => {
        throw new Error('should not load products');
      },
      executor: async () => {
        ran = true;
        return { text: '不该出现' };
      },
    });
    assert.equal(ran, false);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NOT_FOUND');
    assert.equal(JSON.stringify(result).includes('机密草稿'), false);
    assert.equal(JSON.stringify(result).includes('未发布'), false);
  });

  it('rejects a missing video id before loading', async () => {
    let loaded = false;
    const result = await runVideoDocTurn({
      actor: { type: 'end_user', id: 'user-1' },
      text: '你好',
      requestId: 'req-video-3',
      loadVideo: async () => {
        loaded = true;
        return null;
      },
      executor: async () => ({ text: '不该出现' }),
    });
    assert.equal(loaded, false);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'BAD_INPUT');
  });
});
