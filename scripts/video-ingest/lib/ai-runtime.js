// 自动同步自 shared/ai-runtime/index.js，请通过 scripts/sync-ai-runtime.js 更新。
'use strict';

const crypto = require('node:crypto');

const VERSION = 'tokenhub-v1';
const DEFAULT_BASE_URL = 'https://tokenhub.tencentmaas.com/v1';
const TEXT_MODELS = ['hy3', 'hy4-preview', 'deepseek-v4.1-flash-1017', 'deepseek-v4.1-flash',
  'deepseek/deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-pro-0813', 'glm-5.3-flashx',
  'glm-5.3-flash', 'glm-5.3', 'glm-5.2', 'kimi-k3', 'kimi-k2.8-preview',
  'kimi-k2.7-code-highspeed', 'kimi-k2.7-code', 'kimi-k2.6', 'minimax-m3',
  'mimo-v2.6-pro', 'mimo-v2.6-flash', 'step-5-preview'];

function resolveTextModel({ place, stored, env = process.env }) {
  const keys = { video_doc: 'TOKENHUB_VIDEO_DOC_MODEL', customer_service: 'TOKENHUB_CUSTOMER_SERVICE_MODEL', video_intro: 'TOKENHUB_INTRO_MODEL' };
  if (!keys[place]) throw failure('BAD_INPUT');
  const candidates = [stored && stored[place], env[keys[place]], env.TOKENHUB_MODEL];
  if (place !== 'video_intro') candidates.push(env.AGENT_MODEL_NAME);
  return candidates.map(value => String(value || '').trim()).find(value => TEXT_MODELS.includes(value)) || 'hy3';
}

async function loadTextModel(db, place, env) {
  let stored;
  if (db) {
    try {
      const result = await db.collection('admin_config').doc('agent_models').get();
      stored = result && result.data;
    } catch (error) {
      const code = error && (error.errCode || error.code);
      const message = String((error && error.message) || '');
      if (code !== -502005 && code !== 'DATABASE_COLLECTION_NOT_EXIST' && !/not found|not exist|missing document/i.test(message)) throw error;
    }
  }
  return resolveTextModel({ place, stored, env });
}

function failure(code, status) {
  const error = new Error(code);
  error.code = code;
  if (status) error.status = status;
  return error;
}

function createProbeProof(secret, now = Date.now()) {
  if (!secret) throw failure('NOT_CONFIGURED');
  const timestamp = String(now);
  const signature = crypto.createHmac('sha256', secret).update('video-ingest:ai-probe:' + timestamp).digest('hex');
  return timestamp + '.' + signature;
}

function verifyProbeProof(secret, proof, now = Date.now()) {
  if (!secret || typeof proof !== 'string') return false;
  const match = proof.match(/^(\d{13})\.([a-f0-9]{64})$/);
  if (!match || Math.abs(now - Number(match[1])) > 60000) return false;
  const expected = createProbeProof(secret, Number(match[1]));
  return crypto.timingSafeEqual(Buffer.from(proof), Buffer.from(expected));
}

function tokenHubStatus(env = process.env) {
  const missing = [];
  if (!String(env.TOKENHUB_API_KEY || '').trim()) missing.push('TOKENHUB_API_KEY');
  let baseUrl = String(env.TOKENHUB_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
    if (url.pathname !== '/v1') throw new Error();
  } catch {
    missing.push('TOKENHUB_BASE_URL');
    baseUrl = '';
  }
  return { provider: 'tokenhub', version: VERSION, ready: missing.length === 0, missing, baseUrl };
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function usage(body) {
  const value = body && body.usage;
  return { input: count(value && value.prompt_tokens), output: count(value && value.completion_tokens) };
}

function statusCode(status) {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 402) return 'QUOTA';
  if (status === 429) return 'RATE_LIMITED';
  return 'UNAVAILABLE';
}

function createTokenHubClient(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetch || globalThis.fetch;
  const now = options.now || Date.now;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));

  async function post(path, payload, input, validate) {
    const status = tokenHubStatus(env);
    if (!status.ready) throw failure('NOT_CONFIGURED');
    if (typeof fetchImpl !== 'function') throw failure('UNAVAILABLE');
    const duration = Number(input.timeoutMs) || 20000;
    const deadline = Math.min(Number(input.deadline) || Infinity, now() + duration);
    const maxRetries = Math.min(2, Math.max(0, Number(input.maxRetries ?? 1) || 0));
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - now();
      if (remaining <= 0) throw failure('TIMEOUT');
      const controller = new AbortController();
      const startedAt = now();
      let timer;
      let aborted;
      let result;
      let error;
      const abort = () => { controller.abort(); if (aborted) aborted(failure('TIMEOUT')); };
      try {
        result = await Promise.race([
          (async () => {
            const response = await fetchImpl(status.baseUrl + path, {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + String(env.TOKENHUB_API_KEY).trim(), 'Content-Type': 'application/json' },
              body: JSON.stringify(payload), signal: controller.signal, redirect: 'error',
            });
            if (response.status < 200 || response.status >= 300) throw failure(statusCode(response.status), response.status);
            const body = JSON.parse(await response.text());
            if (!body || body.error) throw failure('BAD_RESPONSE');
            validate(body);
            return body;
          })(),
          new Promise((resolve, reject) => {
            aborted = reject;
            timer = setTimeout(abort, remaining);
            if (input.signal) {
              input.signal.addEventListener('abort', abort, { once: true });
              if (input.signal.aborted) abort();
            }
          }),
        ]);
      } catch (caught) {
        const codes = new Set(['TIMEOUT', 'AUTH', 'QUOTA', 'RATE_LIMITED', 'UNAVAILABLE', 'BAD_RESPONSE', 'BAD_DIMENSION']);
        error = codes.has(caught && caught.code) ? failure(caught.code, caught.status) : failure('UNAVAILABLE');
        if (caught instanceof SyntaxError) error = failure('BAD_RESPONSE');
      } finally {
        clearTimeout(timer);
        if (error) controller.abort();
        if (input.signal) input.signal.removeEventListener('abort', abort);
      }
      if (typeof options.onAttempt === 'function') {
        try {
          await options.onAttempt({ provider: 'tokenhub', version: VERSION, operation: path === '/embeddings' ? 'embed' : 'chat', model: (result && result.model) || payload.model, attempt: attempt + 1, startedAt, durationMs: Math.max(0, now() - startedAt), code: error ? error.code : 'ok', usage: usage(result) });
        } catch { /* 观测失败不改变模型结果。 */ }
      }
      if (!error) return result;
      const retryable = error.code === 'RATE_LIMITED' || (error.status >= 500 && error.status <= 599);
      if (!retryable || attempt >= maxRetries) throw error;
      const pause = 200 * (2 ** attempt);
      if (now() + pause >= deadline) throw failure('TIMEOUT');
      await sleep(pause);
    }
  }

  return {
    status: () => tokenHubStatus(env),
    async chat(input) {
      const { model, messages } = input;
      if (!model || !Array.isArray(messages)) throw failure('BAD_INPUT');
      const payload = { model, messages, stream: false };
      for (const key of ['tools', 'tool_choice', 'temperature', 'max_tokens', 'thinking', 'reasoning_effort']) {
        if (input[key] !== undefined) payload[key] = input[key];
      }
      const body = await post('/chat/completions', payload, input, body => {
        const message = body.choices && body.choices[0] && body.choices[0].message;
        if (!message || (typeof message.content !== 'string' && !Array.isArray(message.content) && !Array.isArray(message.tool_calls))) throw failure('BAD_RESPONSE');
      });
      const message = body.choices && body.choices[0] && body.choices[0].message;
      return { message, model: body.model || model, usage: usage(body) };
    },
    async embed(input) {
      if (!input.model || typeof input.input !== 'string' || !input.input.trim() || input.input.length > 2000) throw failure('BAD_INPUT');
      const body = await post('/embeddings', { model: input.model, input: input.input, encoding_format: 'float' }, input, body => {
        if (body.model && body.model !== input.model) throw failure('BAD_RESPONSE');
        const vector = body.data && body.data[0] && body.data[0].embedding;
        if (!Array.isArray(vector) || vector.length !== input.dimensions) throw failure('BAD_DIMENSION');
        if (!vector.every(value => typeof value === 'number' && Number.isFinite(value)) || !vector.some(value => value !== 0)) throw failure('BAD_RESPONSE');
      });
      const vector = body.data && body.data[0] && body.data[0].embedding;
      return { embedding: vector, model: input.model, usage: usage(body) };
    },
  };
}

module.exports = { VERSION, DEFAULT_BASE_URL, TEXT_MODELS, resolveTextModel, loadTextModel, createTokenHubClient, tokenHubStatus, createProbeProof, verifyProbeProof };
