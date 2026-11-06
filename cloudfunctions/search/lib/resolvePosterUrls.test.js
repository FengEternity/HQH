'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { attachPosterUrls, attachResultPosters } = require('./resolvePosterUrls');

describe('attachPosterUrls', () => {
  it('maps cloud cover ids to https posterUrl', async () => {
    const getTempFileURL = async (payload) => {
      assert.equal(payload.fileList.length, 1);
      return {
        fileList: [{ fileID: 'cloud://c', status: 0, tempFileURL: 'https://cdn.example/c.jpg' }],
      };
    };
    const out = await attachPosterUrls([{ id: 'v1', coverFileId: 'cloud://c' }], getTempFileURL);
    assert.equal(out[0].posterUrl, 'https://cdn.example/c.jpg');
  });

  it('leaves posterUrl empty when temp url fails', async () => {
    const getTempFileURL = async () => ({
      fileList: [{ fileID: 'cloud://c', status: -503002, tempFileURL: '' }],
    });
    const out = await attachPosterUrls([{ coverFileId: 'cloud://c' }], getTempFileURL);
    assert.equal(out[0].posterUrl, '');
  });

  it('keeps items when getTempFileURL throws', async () => {
    const out = await attachPosterUrls([{ id: 'v1', coverFileId: 'cloud://c' }], async () => {
      throw new Error('timeout');
    });
    assert.equal(out[0].id, 'v1');
    assert.equal(out[0].posterUrl, '');
  });
});

describe('attachResultPosters', () => {
  it('writes the same cover onto both search lanes with one temp url lookup', async () => {
    const calls = [];
    const getTempFileURL = async (payload) => {
      calls.push(payload.fileList.map((row) => row.fileID));
      return {
        fileList: [{ fileID: 'cloud://c', status: 0, tempFileURL: 'https://cdn.example/c.jpg' }],
      };
    };
    const out = await attachResultPosters({
      ok: true,
      items: [{ id: 'v1', coverFileId: 'cloud://c' }],
      keywordItems: [{ id: 'v1', coverFileId: 'cloud://c' }],
      semanticOnlyItems: [{ id: 'v2', coverFileId: 'https://already.example/p.jpg' }],
    }, getTempFileURL);
    assert.deepEqual(calls, [['cloud://c']]);
    assert.equal(out.items[0].posterUrl, 'https://cdn.example/c.jpg');
    assert.equal(out.keywordItems[0].posterUrl, 'https://cdn.example/c.jpg');
    assert.equal(out.semanticOnlyItems[0].posterUrl, '');
  });
});
