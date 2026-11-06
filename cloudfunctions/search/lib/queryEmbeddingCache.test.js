'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EMBEDDING_DIM, EMBEDDING_MODEL } = require('./searchConfig');
const { QUERY_CACHE_TTL_MS, resolveQueryEmbedding } = require('./queryEmbeddingCache');

function vector() {
  const values = new Array(EMBEDDING_DIM).fill(0);
  values[0] = 1;
  return values;
}

function createDb() {
  const docs = {};
  return {
    docs,
    collection() {
      return {
        doc(id) {
          return {
            get: async () => ({ data: docs[id] }),
            set: async ({ data }) => {
              docs[id] = data;
            },
          };
        },
      };
    },
  };
}

describe('query embedding cache', () => {
  it('embeds once and reuses the vector for a day', async () => {
    const db = createDb();
    let calls = 0;
    const embed = async () => {
      calls += 1;
      return { ok: true, embedding: vector() };
    };
    const first = await resolveQueryEmbedding({ db, sentence: '怎么对中', embed, now: 10 });
    const second = await resolveQueryEmbedding({ db, sentence: '怎么对中', embed, now: 11 });
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(calls, 1);
    assert.equal(second.embedding.length, EMBEDDING_DIM);
    const expired = await resolveQueryEmbedding({
      db,
      sentence: '怎么对中',
      embed,
      now: 11 + QUERY_CACHE_TTL_MS,
    });
    assert.equal(expired.cached, false);
    assert.equal(calls, 2);
  });

  it('embeds again when the cached vector has the wrong length', async () => {
    const db = createDb();
    let calls = 0;
    const embed = async () => {
      calls += 1;
      return { ok: true, embedding: vector() };
    };
    await resolveQueryEmbedding({ db, sentence: '对中', embed, now: 10 });
    const id = Object.keys(db.docs)[0];
    db.docs[id].embedding = [1, 2, 3];
    const again = await resolveQueryEmbedding({ db, sentence: '对中', embed, now: 20 });
    assert.equal(again.cached, false);
    assert.equal(calls, 2);
    assert.equal(again.embedding.length, EMBEDDING_DIM);
    assert.equal(db.docs[id].embeddingModel, EMBEDDING_MODEL);
  });

  it('still searches when the cache cannot be written', async () => {
    const db = {
      collection() {
        return {
          doc() {
            return {
              get: async () => {
                throw new Error('missing');
              },
              set: async () => {
                throw new Error('denied');
              },
            };
          },
        };
      },
    };
    const embedded = await resolveQueryEmbedding({
      db,
      sentence: '对中',
      embed: async () => ({ ok: true, embedding: vector() }),
      now: 10,
    });
    assert.equal(embedded.ok, true);
    assert.equal(embedded.cached, false);
  });
});
