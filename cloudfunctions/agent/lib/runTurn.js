'use strict';

const crypto = require('node:crypto');

const PROFILES = {
  video_doc: {
    version: 'v1',
    tools: ['lookup_current_video_doc'],
  },
  customer_service: {
    version: 'v1',
    tools: ['search', 'own_orders', 'escalate'],
  },
};

function agentRunId(requestId) {
  return crypto.createHash('sha256').update(String(requestId || '')).digest('hex').slice(0, 16);
}

function gateSpan(enteredModel, status) {
  return { name: 'gate', status, durationMs: 0, enteredModel };
}

function cardKey(card) {
  return card && card.type && card.id ? card.type + ':' + card.id : '';
}

function allowedCards(toolResults, tools, proposed) {
  const allowed = new Set();
  for (const tool of toolResults || []) {
    if (!tools.includes(tool.name)) continue;
    for (const card of tool.cards || []) {
      const key = cardKey(card);
      if (key) allowed.add(key);
    }
  }
  return (proposed || []).filter((card) => allowed.has(cardKey(card)));
}

async function runTurn(input) {
  const profile = PROFILES[input && input.profileId];
  const runId = agentRunId(input && input.requestId);
  if (!profile) {
    return {
      ok: false,
      code: 'BAD_INPUT',
      message: '无法处理这次提问',
      agentRunId: runId,
      spans: [gateSpan(false, 'error')],
    };
  }
  const actor = input.actor || {};
  if (actor.type !== 'end_user') {
    return {
      ok: false,
      code: 'FORBIDDEN',
      message: '当前身份不能使用这个助手',
      agentRunId: runId,
      profileId: input.profileId,
      profileVersion: profile.version,
      spans: [gateSpan(false, 'error')],
    };
  }

  const executed = await input.executor({
    profileId: input.profileId,
    profileVersion: profile.version,
    tools: profile.tools.slice(),
  });
  const cards = allowedCards(executed && executed.toolResults, profile.tools, executed && executed.cards);
  const spans = [gateSpan(true, 'ok')];
  if (executed && (executed.model || executed.tokenInput !== undefined)) {
    spans.push({
      name: 'model',
      status: 'ok',
      durationMs: 0,
      enteredModel: true,
      model: executed.model || '',
      tokenInput: Number(executed.tokenInput) || 0,
      tokenOutput: Number(executed.tokenOutput) || 0,
    });
  }
  for (const tool of (executed && executed.toolResults) || []) {
    if (!profile.tools.includes(tool.name)) continue;
    spans.push({
      name: 'tool',
      status: 'ok',
      durationMs: 0,
      enteredModel: true,
      toolName: tool.name,
      resultCode: tool.resultCode || 'ok',
    });
  }
  spans.push({ name: 'persist', status: 'ok', durationMs: 0, enteredModel: true });
  return {
    ok: true,
    text: executed && executed.text ? String(executed.text) : '',
    cards,
    status: 'succeeded',
    agentRunId: runId,
    profileId: input.profileId,
    profileVersion: profile.version,
    spans,
  };
}

module.exports = { runTurn, PROFILES, agentRunId };
