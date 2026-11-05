'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { handleAgentEvent } = require('./videoDocHandler');

function createDb() {
  const rows = { video_doc_threads: [], video_doc_messages: [], agent_runs: [] };
  return {
    collection(name) {
      return {
        add: async ({ data }) => {
          const doc = Object.assign({ _id: name + '-' + rows[name].length }, data);
          rows[name].push(doc);
          return { _id: doc._id };
        },
        where(query) {
          return {
            get: async () => ({
              data: rows[name].filter((row) =>
                Object.keys(query).every((key) => row[key] === query[key]),
              ),
            }),
          };
        },
        doc(id) {
          return {
            update: async ({ data }) => {
              const row = rows[name].find((item) => item._id === id);
              if (row) Object.assign(row, data);
            },
          };
        },
      };
    },
  };
}

describe('handleAgentEvent', () => {
  it('uses the server openid and ignores an openid on the event', async () => {
    const db = createDb();
    const result = await handleAgentEvent(
      db,
      {
        action: 'videoDocSend',
        openid: 'attacker',
        videoId: 'vid-1',
        text: '怎么整平',
        requestId: 'req-1',
      },
      {
        openid: 'user-1',
        now: 10,
        loadVideo: async () => ({ status: 'published', title: '设站', intro: '先整平', tags: [] }),
        loadLinkedProducts: async () => [],
        executor: async () => ({ text: '先整平', model: 'stub', tokenInput: 1, tokenOutput: 1 }),
      },
    );
    assert.equal(result.ok, true);
    const threads = await db.collection('video_doc_threads').where({}).get();
    assert.equal(threads.data[0].openid, 'user-1');
    assert.equal(JSON.stringify(threads.data).includes('attacker'), false);

    const history = await handleAgentEvent(
      db,
      { action: 'videoDocHistory', openid: 'attacker', videoId: 'vid-1' },
      { openid: 'user-2' },
    );
    assert.deepEqual(history.messages, []);
  });
});
