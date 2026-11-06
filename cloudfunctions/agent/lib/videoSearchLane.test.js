'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mergeThreeLaneItems, parseProposedIds, runVideoSearchLoop } = require('./videoSearchLane');

describe('parseProposedIds', () => {
  it('reads a json array and drops duplicates', () => {
    assert.deepEqual(parseProposedIds('找到这些：["cors", "rtk", "cors"]'), ['cors', 'rtk']);
    assert.deepEqual(parseProposedIds('cors\nrtk'), ['cors', 'rtk']);
    assert.deepEqual(parseProposedIds(''), []);
  });
});

describe('mergeThreeLaneItems', () => {
  const keywordItems = [{ type: 'video', id: 'kw', title: '关键词' }];
  const semanticOnlyItems = [{ type: 'video', id: 'rag', title: '语义' }];
  const cardById = {
    llm: { id: 'llm', title: '模型找的', brandName: '南方', brandId: 'b1', modelName: '', tags: [], summary: 's', coverFileId: 'cloud://c' },
  };

  it('keeps only proposed ids the tool returned, in order', () => {
    const items = mergeThreeLaneItems({
      keywordItems,
      proposedIds: ['missing', 'llm', 'kw'],
      cardById,
      semanticOnlyItems,
    });
    assert.deepEqual(items.map((item) => item.id), ['kw', 'llm', 'rag']);
    assert.equal(items[1].coverFileId, 'cloud://c');
    assert.equal(items[1].type, 'video');
  });
});

describe('runVideoSearchLoop', () => {
  const card = { id: 'cors', title: '南方CORS设置', brandName: '南方', brandId: 'b1', modelName: '', tags: [], summary: 's', coverFileId: '' };

  it('rewrites once, calls the tool, and finishes with the proposed ids', async () => {
    const seen = [];
    const steps = [];
    const result = await runVideoSearchLoop({
      model: 'hy3',
      query: '怎么设置账号',
      now: () => 0,
      budgetMs: 20000,
      maxCalls: 3,
      onStep: async (step) => { steps.push(`${step.key}:${step.state}:${step.detail || ''}`); },
      findVideos: async (query) => { seen.push(query); return [card]; },
      chat: async ({ messages, tool_choice }) => {
        const toolTurns = messages.filter((m) => m.role === 'tool').length;
        if (toolTurns === 0) {
          return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'find_videos', arguments: '{"query":"账号设置"}' } }] } };
        }
        assert.equal(tool_choice, 'auto');
        return { message: { role: 'assistant', content: '["cors"]' } };
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(seen, ['账号设置']);
    assert.deepEqual(result.calls, ['账号设置']);
    assert.deepEqual(result.proposedIds, ['cors']);
    assert.ok(result.cardById.cors);
    assert.deepEqual(steps, [
      'understand:running:',
      'understand:done:',
      'find:账号设置:running:',
      'find:账号设置:done:找到 1 条',
      'pick:running:',
      'understand:done:',
      'pick:done:1 条',
    ]);
  });

  it('fails closed when the model throws', async () => {
    const result = await runVideoSearchLoop({
      model: 'hy3',
      query: '怎么设置账号',
      now: () => 0,
      budgetMs: 20000,
      maxCalls: 3,
      findVideos: async () => [],
      chat: async () => { const e = new Error('UNAVAILABLE'); e.code = 'UNAVAILABLE'; throw e; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'UNAVAILABLE');
    assert.deepEqual(result.proposedIds, []);
  });

  it('forces the model to wrap up after the third tool call', async () => {
    const choices = [];
    const result = await runVideoSearchLoop({
      model: 'hy3',
      query: '怎么设置账号',
      now: () => 0,
      budgetMs: 20000,
      maxCalls: 3,
      findVideos: async () => [card],
      chat: async ({ tool_choice }) => {
        choices.push(tool_choice);
        if (choices.length <= 3) {
          return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'c' + choices.length, type: 'function', function: { name: 'find_videos', arguments: '{"query":"q' + choices.length + '"}' } }] } };
        }
        assert.equal(tool_choice, 'none');
        return { message: { role: 'assistant', content: '["cors"]' } };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.calls.length, 3);
    assert.equal(choices[3], 'none');
  });
});
