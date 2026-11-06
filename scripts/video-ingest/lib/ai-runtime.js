// 自动同步自 shared/ai-runtime/index.js，请通过 scripts/sync-ai-runtime.js 更新。
'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');

const VERSION = 'cloudbase-v1';
const DEFAULT_BASE_URL = 'https://tokenhub.tencentmaas.com/v1';
const TEXT_MODELS = ['hy3', 'hy4-preview', 'deepseek-v4.1-flash-1017', 'deepseek-v4.1-flash',
  'deepseek/deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-pro-0813', 'glm-5.3-flashx',
  'glm-5.3-flash', 'glm-5.3', 'glm-5.2', 'kimi-k3', 'kimi-k2.8-preview',
  'kimi-k2.7-code-highspeed', 'kimi-k2.7-code', 'kimi-k2.6', 'minimax-m3',
  'mimo-v2.6-pro', 'mimo-v2.6-flash', 'step-5-preview'];

function resolveTextModel({ place, stored, env = process.env }) {
  const keys = { video_doc: 'TOKENHUB_VIDEO_DOC_MODEL', customer_service: 'TOKENHUB_CUSTOMER_SERVICE_MODEL', video_intro: 'TOKENHUB_INTRO_MODEL', video_search: 'TOKENHUB_VIDEO_SEARCH_MODEL' };
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

function createServiceProof(secret, purpose, now = Date.now()) {
  if (!secret) throw failure('NOT_CONFIGURED');
  if (typeof purpose !== 'string' || !/^[a-z0-9:-]{1,80}$/.test(purpose)) throw failure('BAD_INPUT');
  const timestamp = String(now);
  const signature = crypto.createHmac('sha256', secret).update(purpose + ':' + timestamp).digest('hex');
  return timestamp + '.' + signature;
}

function verifyServiceProof(secret, purpose, proof, now = Date.now()) {
  if (!secret || typeof purpose !== 'string' || typeof proof !== 'string') return false;
  if (!/^[a-z0-9:-]{1,80}$/.test(purpose)) return false;
  const match = proof.match(/^(\d{13})\.([a-f0-9]{64})$/);
  if (!match || Math.abs(now - Number(match[1])) > 60000) return false;
  const expected = createServiceProof(secret, purpose, Number(match[1]));
  return crypto.timingSafeEqual(Buffer.from(proof), Buffer.from(expected));
}

function createProbeProof(secret, now = Date.now()) {
  return createServiceProof(secret, 'video-ingest:ai-probe', now);
}

function verifyProbeProof(secret, proof, now = Date.now()) {
  return verifyServiceProof(secret, 'video-ingest:ai-probe', proof, now);
}

function envIdOk(value) {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(value);
}

function chatStatus(env = process.env) {
  const missing = [];
  const envId = String(env.TCB_ENV_ID || '').trim();
  if (!envIdOk(envId)) missing.push('TCB_ENV_ID');
  if (!String(env.TCB_API_KEY || '').trim()) missing.push('TCB_API_KEY');
  return {
    provider: 'cloudbase',
    version: VERSION,
    ready: missing.length === 0,
    missing,
    baseUrl: missing.includes('TCB_ENV_ID') ? '' : `https://${envId}.api.tcloudbasegateway.com/v1/ai/cloudbase`,
  };
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
  return { provider: 'tokenhub', version: 'tokenhub-v1', ready: missing.length === 0, missing, baseUrl };
}

function withKey(status, apiKey) {
  return Object.assign({}, status, { apiKey: String(apiKey || '').trim() });
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

function nodeFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const headers = Object.assign({}, options.headers);
    if (options.body != null && headers['Content-Length'] == null && headers['content-length'] == null) {
      headers['Content-Length'] = Buffer.byteLength(options.body);
    }
    let settled = false;
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: options.method || 'GET',
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        if (settled) return;
        settled = true;
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, text: async () => text });
      });
    });
    const stop = () => {
      settled = true;
      request.destroy();
    };
    request.on('error', (error) => {
      if (!settled) reject(error);
    });
    if (options.signal) {
      if (options.signal.aborted) {
        settled = true;
        request.destroy();
        reject(failure('TIMEOUT'));
        return;
      }
      options.signal.addEventListener('abort', stop, { once: true });
    }
    if (options.body != null) request.write(options.body);
    request.end();
  });
}

function selectFetch(explicit) {
  if (typeof explicit === 'function') return explicit;
  if (typeof globalThis.fetch === 'function') return globalThis.fetch;
  return nodeFetch;
}

function createTokenHubClient(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = selectFetch(options.fetch);
  const now = options.now || Date.now;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));

  async function post(target, path, payload, input, validate) {
    if (!target.ready) throw failure('NOT_CONFIGURED');
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
            const response = await fetchImpl(target.baseUrl + path, {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + target.apiKey, 'Content-Type': 'application/json' },
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
        if (caught instanceof SyntaxError) {
          error = failure('BAD_RESPONSE');
        } else if (codes.has(caught && caught.code)) {
          error = failure(caught.code, caught.status);
        } else {
          error = failure('UNAVAILABLE');
          error.reason = 'network';
        }
      } finally {
        clearTimeout(timer);
        if (error) controller.abort();
        if (input.signal) input.signal.removeEventListener('abort', abort);
      }
      if (typeof options.onAttempt === 'function') {
        try {
          await options.onAttempt({ provider: target.provider, version: target.version, operation: path === '/embeddings' ? 'embed' : 'chat', model: (result && result.model) || payload.model, attempt: attempt + 1, startedAt, durationMs: Math.max(0, now() - startedAt), code: error ? error.code : 'ok', usage: usage(result) });
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
    status: () => chatStatus(env),
    async chat(input) {
      const { model, messages } = input;
      if (!model || !Array.isArray(messages)) throw failure('BAD_INPUT');
      const payload = { model, messages, stream: false };
      for (const key of ['tools', 'tool_choice', 'temperature', 'max_tokens', 'thinking', 'reasoning_effort']) {
        if (input[key] !== undefined) payload[key] = input[key];
      }
      const body = await post(withKey(chatStatus(env), env.TCB_API_KEY), '/chat/completions', payload, input, body => {
        const message = body.choices && body.choices[0] && body.choices[0].message;
        if (!message || (typeof message.content !== 'string' && !Array.isArray(message.content) && !Array.isArray(message.tool_calls))) throw failure('BAD_RESPONSE');
      });
      const message = body.choices && body.choices[0] && body.choices[0].message;
      return { message, model: body.model || model, usage: usage(body) };
    },
    async embed(input) {
      if (!input.model || typeof input.input !== 'string' || !input.input.trim() || input.input.length > 2000) throw failure('BAD_INPUT');
      const body = await post(withKey(tokenHubStatus(env), env.TOKENHUB_API_KEY), '/embeddings', { model: input.model, input: input.input, encoding_format: 'float' }, input, body => {
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

module.exports = { VERSION, DEFAULT_BASE_URL, TEXT_MODELS, resolveTextModel, loadTextModel, createTokenHubClient, chatStatus, tokenHubStatus, createServiceProof, verifyServiceProof, createProbeProof, verifyProbeProof, nodeFetch, selectFetch };
