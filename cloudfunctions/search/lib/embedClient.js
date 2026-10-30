'use strict';

const https = require('https');
const { EMBEDDING_MODEL } = require('./searchConfig');
const { parseEmbeddingResponse } = require('./embedResponse');

const EMBED_HOST = 'tokenhub.tencentmaas.com';
const EMBED_PATH = '/v1/embeddings';
const EMBED_TIMEOUT_MS = 12000;

function defaultRequest(options, body) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    const req = https.request(options, (res) => {
      const parts = [];
      res.on('data', (part) => parts.push(part));
      res.on('end', () => {
        finish({
          statusCode: res.statusCode,
          body: Buffer.concat(parts).toString('utf8'),
        });
      });
    });
    req.setTimeout(EMBED_TIMEOUT_MS, () => {
      finish({ timeout: true });
      req.destroy();
    });
    req.on('error', () => finish({ error: true }));
    req.write(body);
    req.end();
  });
}

async function embedChunkText(text, deps) {
  const env = (deps && deps.env) || process.env;
  const request = (deps && deps.request) || defaultRequest;
  const apiKey = String(env.TOKENHUB_API_KEY || '').trim();
  if (!apiKey) {
    return { ok: false, error: 'embed_failed' };
  }
  const payload = JSON.stringify({
    model: EMBEDDING_MODEL,
    input: text,
    encoding_format: 'float',
  });
  let response;
  try {
    response = await request(
      {
        protocol: 'https:',
        hostname: EMBED_HOST,
        path: EMBED_PATH,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      payload,
    );
  } catch (error) {
    return { ok: false, error: 'embed_failed' };
  }
  if (!response || response.timeout) {
    return { ok: false, error: 'embed_timeout' };
  }
  if (response.error || response.statusCode !== 200) {
    return { ok: false, error: 'embed_failed' };
  }
  try {
    return parseEmbeddingResponse(JSON.parse(response.body));
  } catch (error) {
    return { ok: false, error: 'embed_failed' };
  }
}

module.exports = {
  EMBED_TIMEOUT_MS,
  embedChunkText,
};
