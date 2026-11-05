'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { videoDocSend } = require('./videoDocAction');

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
          const match = () =>
            rows[name].filter((row) => Object.keys(query).every((key) => row[key] === query[key]));
          return {
            get: async () => ({ data: match() }),
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

function publishedLoad(videoId) {
  return async (id) => {
    assert.equal(id, videoId);
    return { status: 'published', title: '全站仪设站', intro: '先整平', tags: [], brandName: '华测', modelName: 'i90' };
  };
}

describe('videoDocSend', () => {
  it('stores the turn on the current video and ignores another video id from the model', async () => {
    const db = createDb();
    const first = await videoDocSend(db, {
      openid: 'user-1',
      videoId: 'vid-1',
      text: '怎么整平',
      requestId: 'req-1',
      now: 10,
      loadVideo: publishedLoad('vid-1'),
      loadLinkedProducts: async () => [],
      executor: async ({ tools }) => {
        await tools.lookup_current_video_doc({ videoId: 'vid-other' });
        return { text: '先整平', model: 'stub', tokenInput: 1, tokenOutput: 1, toolResults: [], cards: [] };
      },
    });
    assert.equal(first.ok, true);
    assert.deepEqual(
      first.messages.map((item) => item.role + ':' + item.text),
      ['user:怎么整平', 'assistant:先整平'],
    );
    assert.equal(first.messages[1].meta.source, 'agent');

    const other = await videoDocSend(db, {
      openid: 'user-1',
      videoId: 'vid-2',
      text: '另一条',
      requestId: 'req-2',
      now: 11,
      loadVideo: publishedLoad('vid-2'),
      loadLinkedProducts: async () => [],
      executor: async () => ({ text: '另一答', model: 'stub', tokenInput: 1, tokenOutput: 1 }),
    });
    assert.deepEqual(
      other.messages.map((item) => item.text),
      ['另一条', '另一答'],
    );
    assert.deepEqual(
      first.messages.map((item) => item.text),
      ['怎么整平', '先整平'],
    );
  });

  it('does not store draft copy when the video is not published', async () => {
    const db = createDb();
    const result = await videoDocSend(db, {
      openid: 'user-1',
      videoId: 'vid-draft',
      text: '简介',
      requestId: 'req-3',
      now: 12,
      loadVideo: async () => ({ status: 'draft', intro: '机密草稿' }),
      loadLinkedProducts: async () => [],
      executor: async () => ({ text: '不该存' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NOT_FOUND');
    assert.equal(JSON.stringify(result).includes('机密草稿'), false);
    const threads = await db.collection('video_doc_threads').where({}).get();
    assert.equal(threads.data.length, 0);
  });

  it('keeps control records free of openid and message text', async () => {
    const db = createDb();
    await videoDocSend(db, {
      openid: 'user-1',
      videoId: 'vid-1',
      text: '怎么整平',
      requestId: 'req-1',
      now: 10,
      loadVideo: publishedLoad('vid-1'),
      loadLinkedProducts: async () => [],
      executor: async () => ({ text: '先整平', model: 'stub', tokenInput: 1, tokenOutput: 1 }),
    });
    const runs = await db.collection('agent_runs').where({}).get();
    const blob = JSON.stringify(runs.data);
    assert.equal(blob.includes('user-1'), false);
    assert.equal(blob.includes('怎么整平'), false);
    assert.equal(runs.data[0].status, 'succeeded');
    assert.equal(runs.data[0].actorType, 'end_user');
    assert.equal(runs.data[0].profileId, 'video_doc');
  });

  it('replays a finished request without calling the model again', async () => {
    const db = createDb();
    let calls = 0;
    const input = {
      openid: 'user-1',
      videoId: 'vid-1',
      text: '怎么整平',
      requestId: 'req-1',
      now: 10,
      loadVideo: publishedLoad('vid-1'),
      loadLinkedProducts: async () => [],
      executor: async () => {
        calls += 1;
        return { text: '先整平', model: 'stub', tokenInput: 1, tokenOutput: 1 };
      },
    };
    await videoDocSend(db, input);
    const again = await videoDocSend(db, input);
    assert.equal(calls, 1);
    assert.equal(again.status, 'replayed');
    assert.equal(again.text, '先整平');
    const messages = await db.collection('video_doc_messages').where({}).get();
    assert.equal(messages.data.length, 2);
  });

  it('does not write a message when content check rejects the text', async () => {
    const db = createDb();
    let called = false;
    const result = await videoDocSend(db, {
      openid: 'user-1',
      videoId: 'vid-1',
      text: '违规内容',
      requestId: 'req-4',
      now: 10,
      loadVideo: publishedLoad('vid-1'),
      loadLinkedProducts: async () => [],
      checkContent: async () => {
        const error = new Error('rejected');
        error.code = 'CONTENT_REJECTED';
        throw error;
      },
      executor: async () => {
        called = true;
        return { text: '不该出现' };
      },
    });
    assert.equal(result.code, 'CONTENT_REJECTED');
    assert.equal(called, false);
    const messages = await db.collection('video_doc_messages').where({}).get();
    assert.equal(messages.data.length, 0);
  });

  it('returns in progress when the same video already has a running turn', async () => {
    const db = createDb();
    let nested;
    await videoDocSend(db, {
      openid: 'user-1',
      videoId: 'vid-1',
      text: '第一问',
      requestId: 'req-a',
      now: 10,
      loadVideo: publishedLoad('vid-1'),
      loadLinkedProducts: async () => [],
      executor: async () => {
        nested = await videoDocSend(db, {
          openid: 'user-1',
          videoId: 'vid-1',
          text: '第二问',
          requestId: 'req-b',
          now: 11,
          loadVideo: publishedLoad('vid-1'),
          loadLinkedProducts: async () => [],
          executor: async () => {
            throw new Error('should not run');
          },
        });
        return { text: '先整平', model: 'stub', tokenInput: 1, tokenOutput: 1 };
      },
    });
    assert.equal(nested.code, 'IN_PROGRESS');
    const messages = await db.collection('video_doc_messages').where({}).get();
    assert.deepEqual(messages.data.map((item) => item.text), ['第一问', '先整平']);
  });

  it('stops a seventh new turn inside one minute', async () => {
    const db = createDb();
    let calls = 0;
    for (let i = 0; i < 6; i += 1) {
      const result = await videoDocSend(db, {
        openid: 'user-1',
        videoId: 'vid-1',
        text: '问题' + i,
        requestId: 'req-' + i,
        now: 1000 + i,
        loadVideo: publishedLoad('vid-1'),
        loadLinkedProducts: async () => [],
        executor: async () => {
          calls += 1;
          return { text: '答' + i, model: 'stub', tokenInput: 1, tokenOutput: 1 };
        },
      });
      assert.equal(result.ok, true);
    }
    const blocked = await videoDocSend(db, {
      openid: 'user-1',
      videoId: 'vid-1',
      text: '第七问',
      requestId: 'req-6',
      now: 1006,
      loadVideo: publishedLoad('vid-1'),
      loadLinkedProducts: async () => [],
      executor: async () => {
        calls += 1;
        return { text: '不该答' };
      },
    });
    assert.equal(blocked.code, 'RATE_LIMITED');
    assert.equal(calls, 6);
  });

  it('keeps the user message when the model call fails', async () => {
    const db = createDb();
    const result = await videoDocSend(db, {
      openid: 'user-1',
      videoId: 'vid-1',
      text: '怎么整平',
      requestId: 'req-model-fail',
      now: 10,
      loadVideo: publishedLoad('vid-1'),
      loadLinkedProducts: async () => [],
      executor: async () => {
        const error = new Error('vendor down');
        error.code = 'MODEL_UNAVAILABLE';
        throw error;
      },
    });
    assert.equal(result.code, 'MODEL_UNAVAILABLE');
    assert.equal(result.message, '暂时无法回答，请稍后再试');
    assert.equal(JSON.stringify(result).includes('vendor down'), false);
    const messages = await db.collection('video_doc_messages').where({}).get();
    assert.deepEqual(messages.data.map((item) => item.role), ['user']);
  });

  it('keeps the user message when no model is configured', async () => {
    const db = createDb();
    const result = await videoDocSend(db, {
      openid: 'user-1',
      videoId: 'vid-1',
      text: '怎么整平',
      requestId: 'req-model',
      now: 10,
      loadVideo: publishedLoad('vid-1'),
      loadLinkedProducts: async () => [],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'MODEL_UNAVAILABLE');
    assert.equal(JSON.stringify(result).includes('先整平'), false);
    const messages = await db.collection('video_doc_messages').where({}).get();
    assert.deepEqual(messages.data.map((item) => item.role), ['user']);
  });

  it('resumes a failed request once and then stops', async () => {
    const db = createDb();
    const base = {
      openid: 'user-1',
      videoId: 'vid-1',
      text: '怎么整平',
      requestId: 'req-resume',
      now: 10,
      loadVideo: publishedLoad('vid-1'),
      loadLinkedProducts: async () => [],
    };
    const first = await videoDocSend(db, base);
    assert.equal(first.code, 'MODEL_UNAVAILABLE');
    const second = await videoDocSend(db, base);
    assert.equal(second.code, 'MODEL_UNAVAILABLE');
    let calls = 0;
    const third = await videoDocSend(db, Object.assign({}, base, {
      executor: async () => {
        calls += 1;
        return { text: '先整平', model: 'stub', tokenInput: 1, tokenOutput: 1 };
      },
    }));
    assert.equal(calls, 0);
    assert.equal(third.ok, false);
    const messages = await db.collection('video_doc_messages').where({}).get();
    assert.deepEqual(messages.data.map((item) => item.role), ['user']);
  });

  it('still returns the answer when trace export fails', async () => {
    const db = createDb();
    const result = await videoDocSend(db, {
      openid: 'user-1',
      videoId: 'vid-1',
      text: '怎么整平',
      requestId: 'req-trace',
      now: 10,
      loadVideo: publishedLoad('vid-1'),
      loadLinkedProducts: async () => [],
      executor: async () => ({ text: '先整平', model: 'stub', tokenInput: 1, tokenOutput: 1 }),
      exportTrace: async () => {
        throw new Error('forseti down');
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.text, '先整平');
  });
});
