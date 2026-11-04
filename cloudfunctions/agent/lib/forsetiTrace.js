'use strict';

const crypto = require('node:crypto');

const SPAN_NAMES = new Set(['gate', 'context', 'model', 'tool', 'persist']);
const STRING_FIELDS = [
  'status',
  'errorClass',
  'requestId',
  'agentRunId',
  'profileId',
  'profileVersion',
  'scopeHash',
  'model',
  'toolName',
  'resultCode',
  'provider',
  'configVersion',
];
const INT_FIELDS = ['durationMs', 'tokenInput', 'tokenOutput', 'attempt'];

function hexId(seed, size) {
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, size);
}

function attribute(key, value) {
  if (INT_FIELDS.includes(key)) {
    return { key, value: { intValue: String(value) } };
  }
  if (key === 'enteredModel') {
    return { key, value: { boolValue: value === true } };
  }
  return { key, value: { stringValue: String(value) } };
}

function spanAttributes(turn, span) {
  const source = Object.assign({}, turn, span);
  const attributes = [];
  for (const key of STRING_FIELDS) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== '') {
      attributes.push(attribute(key, source[key]));
    }
  }
  for (const key of INT_FIELDS) {
    if (source[key] !== null && source[key] !== undefined && Number.isFinite(Number(source[key]))) {
      attributes.push(attribute(key, Number(source[key])));
    }
  }
  if (span.enteredModel !== undefined) {
    attributes.push(attribute('enteredModel', span.enteredModel));
  }
  return attributes;
}

function buildTrace(turn) {
  const spans = (turn.spans || []).filter((span) => SPAN_NAMES.has(span.name));
  const traceId = hexId(String(turn.agentRunId || turn.requestId || 'trace'), 32);
  const now = Date.now();
  const bounds = spans.map(span => {
    const start = Number.isFinite(span.startedAt) ? span.startedAt : now;
    return [start, start + Math.max(0, Number(span.durationMs) || 0)];
  });
  let rootId = '';
  return {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: spans.map((span, index) => {
              const spanId = hexId(traceId + ':' + span.name + ':' + index, 16);
              if (!rootId) rootId = spanId;
              const rootGate = index === 0 && span.name === 'gate';
              const startedAt = rootGate ? Math.min(...bounds.map(item => item[0])) : bounds[index][0];
              const end = rootGate ? Math.max(...bounds.map(item => item[1])) : bounds[index][1];
              const body = {
                traceId,
                spanId,
                name: span.name,
                kind: 'SPAN_KIND_INTERNAL',
                startTimeUnixNano: String(BigInt(Math.trunc(startedAt)) * 1000000n),
                endTimeUnixNano: String(BigInt(Math.trunc(end)) * 1000000n),
                attributes: spanAttributes(turn, rootGate ? { ...span, durationMs: end - startedAt } : span),
                status: {
                  code: span.status === 'ok' ? 'STATUS_CODE_OK' : 'STATUS_CODE_ERROR',
                },
              };
              if (rootId !== spanId) body.parentSpanId = rootId;
              return body;
            }),
          },
        ],
      },
    ],
  };
}

async function exportForsetiTrace(input) {
  const publicKey = input && input.publicKey;
  const secretKey = input && input.secretKey;
  if (!publicKey || !secretKey) {
    return { ok: false, code: 'NO_CREDENTIALS' };
  }
  const data = buildTrace(input.turn || {});
  try {
    const response = await input.transport({
      path: '/v1/traces',
      method: 'POST',
      header: {
        'X-WX-SERVICE': 'forseti',
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(publicKey + ':' + secretKey).toString('base64'),
      },
      data,
    });
    if (response && Number(response.statusCode) >= 400) {
      return { ok: false, code: 'TRACE_EXPORT_FAILED' };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, code: 'TRACE_EXPORT_FAILED' };
  }
}

module.exports = { exportForsetiTrace, buildTrace };
