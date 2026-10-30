'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { embedChunkText } = require('./embedClient');

function vector() {
  return new Array(1024).fill(0.1);
}

describe('embedChunkText', () => {
  it('posts one text to TokenHub and keeps the key out of the result', async () => {
    let seen;
    const result = await embedChunkText('主机架设', {
      env: { TOKENHUB_API_KEY: 'secret-key' },
      request: async (options, body) => {
        seen = { options, body };
        return {
          statusCode: 200,
          body: JSON.stringify({ data: [{ embedding: vector() }] }),
        };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.embedding.length, 1024);
    assert.equal(seen.options.hostname, 'tokenhub.tencentmaas.com');
    assert.equal(seen.options.path, '/v1/embeddings');
    assert.equal(seen.options.headers.Authorization, 'Bearer secret-key');
    assert.deepEqual(JSON.parse(seen.body), {
      model: 'kinfra-text-embedding-0.6b',
      input: '主机架设',
      encoding_format: 'float',
    });
    assert.equal(JSON.stringify(result).includes('secret-key'), false);
  });

  it('does not call the network when the key is missing', async () => {
    let called = false;
    const result = await embedChunkText('主机架设', {
      env: {},
      request: async () => {
        called = true;
        return { statusCode: 200, body: '{}' };
      },
    });
    assert.equal(called, false);
    assert.deepEqual(result, { ok: false, error: 'embed_failed' });
  });

  it('maps timeout, bad status, and a short vector', async () => {
    const timeout = await embedChunkText('主机架设', {
      env: { TOKENHUB_API_KEY: 'secret-key' },
      request: async () => ({ timeout: true }),
    });
    assert.equal(timeout.error, 'embed_timeout');
    const failed = await embedChunkText('主机架设', {
      env: { TOKENHUB_API_KEY: 'secret-key' },
      request: async () => ({ statusCode: 500, body: '' }),
    });
    assert.equal(failed.error, 'embed_failed');
    const short = await embedChunkText('主机架设', {
      env: { TOKENHUB_API_KEY: 'secret-key' },
      request: async () => ({
        statusCode: 200,
        body: JSON.stringify({ data: [{ embedding: [1, 2] }] }),
      }),
    });
    assert.equal(short.error, 'bad_dimension');
  });
});
