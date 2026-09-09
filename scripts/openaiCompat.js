'use strict';

function getAiEnv() {
  const baseUrl = String(process.env.OPENAI_BASE_URL || '').replace(/\/+$/, '');
  return {
    baseUrl,
    apiKey: String(process.env.OPENAI_API_KEY || ''),
    chatModel: String(process.env.OPENAI_CHAT_MODEL || 'deepseek-chat'),
    embedModel: String(process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small'),
  };
}

function assertKey(env) {
  if (!env.apiKey) {
    const err = new Error('NO_API_KEY');
    err.code = 'NO_API_KEY';
    throw err;
  }
  if (!env.baseUrl) {
    const err = new Error('NO_API_BASE');
    err.code = 'NO_API_BASE';
    throw err;
  }
}

async function postJson(env, path, body, timeoutMs) {
  assertKey(env);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
  try {
    const res = await fetch(env.baseUrl + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + env.apiKey,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      const err = new Error('上游返回非 JSON');
      err.code = 'BAD_UPSTREAM';
      throw err;
    }
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || text.slice(0, 200);
      const err = new Error(msg || '上游错误 ' + res.status);
      err.code = 'UPSTREAM';
      throw err;
    }
    return data;
  } catch (error) {
    if (error && error.name === 'AbortError') {
      const err = new Error('上游超时');
      err.code = 'TIMEOUT';
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function chatJson(opts) {
  const env = getAiEnv();
  const data = await postJson(
    env,
    '/v1/chat/completions',
    {
      model: env.chatModel,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
    },
    opts.timeoutMs,
  );
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  const { parseJsonContent } = require('../cloudfunctions/catalog/lib/aiSearch');
  try {
    return parseJsonContent(content);
  } catch (error) {
    const err = new Error('模型未返回 JSON');
    err.code = 'BAD_JSON';
    throw err;
  }
}

async function embedTexts(texts, timeoutMs) {
  const env = getAiEnv();
  const input = (texts || []).map((item) => String(item || '').slice(0, 8000));
  if (!input.length) {
    return [];
  }
  const data = await postJson(
    env,
    '/v1/embeddings',
    { model: env.embedModel, input },
    timeoutMs,
  );
  const rows = (data.data || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0));
  if (rows.length !== input.length) {
    const err = new Error('向量条数不匹配');
    err.code = 'EMBED_FAIL';
    throw err;
  }
  return rows.map((row) => row.embedding);
}

module.exports = { getAiEnv, chatJson, embedTexts };
