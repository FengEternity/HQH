'use strict';

const VIDEO_SEARCH_SYSTEM = [
  '你在为一个测量仪器讲解小程序找已上架的讲解视频。',
  '用户原句可能不是视频里的写法。你可以把原句改写成更短的词，多次调用 find_videos。',
  'find_videos 只认整句连续出现：把「怎么设置账号」收成「账号设置」才查得到。',
  '不要闲聊。找齐或次数用尽后，最后一轮只输出一个 JSON 数组，元素是你认定相关的视频 id。',
  'id 必须来自本轮 find_videos 返回的卡片，不要自己编。',
].join('\n');

const VIDEO_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'find_videos',
    description: '按短查询找已上架的讲解视频。查询会被归一化并做同义词替换，替换后的整句必须连续出现在视频文案里才命中。一次最多 8 张卡片。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '改写后的短查询，例如「账号设置」' },
      },
      required: ['query'],
    },
  },
};

function parseProposedIds(text) {
  const raw = String(text || '').trim();
  if (!raw) {
    return [];
  }
  const seen = new Set();
  const out = [];
  const push = (value) => {
    const id = String(value || '').trim();
    if (!id || seen.has(id)) {
      return;
    }
    seen.add(id);
    out.push(id);
  };
  const match = raw.match(/\[[\s\S]*?\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) {
        for (const value of parsed) {
          push(value);
        }
        return out;
      }
    } catch (error) {
      // 落回按行切分
    }
  }
  for (const part of raw.split(/[\s,，、;；]+/)) {
    push(part);
  }
  return out;
}

function cardToItem(card) {
  return {
    type: 'video',
    id: card.id,
    title: card.title || '',
    coverFileId: card.coverFileId || '',
    summary: card.summary || '',
    brandName: card.brandName || '',
    brandId: card.brandId || '',
    modelName: card.modelName || '',
    tags: Array.isArray(card.tags) ? card.tags : [],
  };
}

function mergeThreeLaneItems({ keywordItems, proposedIds, cardById, semanticOnlyItems }) {
  const seen = new Set();
  const out = [];
  const push = (item) => {
    const id = String(item && item.id);
    if (!item || seen.has(id)) {
      return;
    }
    seen.add(id);
    out.push(item);
  };
  for (const item of keywordItems || []) {
    push(item);
  }
  for (const id of proposedIds || []) {
    const card = (cardById || {})[id];
    if (card) {
      push(cardToItem(card));
    }
  }
  for (const item of semanticOnlyItems || []) {
    push(item);
  }
  return out;
}

function toolCallQuery(call) {
  try {
    const args = JSON.parse((call && call.function && call.function.arguments) || '{}');
    return String(args.query || '').trim();
  } catch (error) {
    return '';
  }
}

async function runVideoSearchLoop({ chat, model, query, findVideos, now, budgetMs, maxCalls }) {
  const startedAt = now();
  const deadline = startedAt + budgetMs;
  const calls = [];
  const cardById = {};
  const messages = [
    { role: 'system', content: VIDEO_SEARCH_SYSTEM },
    { role: 'user', content: query },
  ];
  const fail = (error) => ({ ok: false, error, proposedIds: [], cardById, calls });
  for (let turn = 0; turn < maxCalls + 3; turn += 1) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      return fail('TIMEOUT');
    }
    const toolChoice = calls.length >= maxCalls ? 'none' : 'auto';
    let reply;
    try {
      reply = await chat({
        model,
        messages,
        tools: [VIDEO_SEARCH_TOOL],
        tool_choice: toolChoice,
        timeoutMs: remaining,
        deadline,
      });
    } catch (error) {
      return fail((error && error.code) || 'UNAVAILABLE');
    }
    const message = reply && reply.message;
    const toolCalls = (message && Array.isArray(message.tool_calls) && message.tool_calls) || [];
    if (!toolCalls.length) {
      return {
        ok: true,
        proposedIds: parseProposedIds(message && message.content),
        cardById,
        calls,
      };
    }
    messages.push({ role: 'assistant', content: (message && message.content) || '', tool_calls: toolCalls });
    for (const call of toolCalls) {
      let cards = [];
      if (calls.length < maxCalls) {
        const toolQuery = toolCallQuery(call);
        if (toolQuery) {
          calls.push(toolQuery);
          try {
            cards = (await findVideos(toolQuery)) || [];
          } catch (error) {
            cards = [];
          }
          for (const card of cards) {
            if (card && card.id) {
              cardById[String(card.id)] = card;
            }
          }
        }
      }
      messages.push({
        role: 'tool',
        tool_call_id: call && call.id,
        content: JSON.stringify({ cards }),
      });
    }
  }
  return fail('LOOP_LIMIT');
}

module.exports = {
  VIDEO_SEARCH_SYSTEM,
  VIDEO_SEARCH_TOOL,
  mergeThreeLaneItems,
  parseProposedIds,
  runVideoSearchLoop,
};
