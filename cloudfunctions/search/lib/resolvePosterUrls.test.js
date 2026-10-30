'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { attachPosterUrls } = require('./resolvePosterUrls');

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
