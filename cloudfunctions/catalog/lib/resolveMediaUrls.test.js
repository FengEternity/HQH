'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { tempUrlFromFileList, resolveMediaUrls } = require('./resolveMediaUrls');

describe('tempUrlFromFileList', () => {
  it('returns empty when fileId is missing', () => {
    assert.equal(tempUrlFromFileList([{ fileID: 'cloud://a', status: 0, tempFileURL: 'https://x' }], ''), '');
  });

  it('returns tempFileURL only when status is 0', () => {
    const list = [
      { fileID: 'cloud://v', status: -503002, tempFileURL: '', errMsg: 'permission denied' },
      { fileID: 'cloud://c', status: 0, tempFileURL: 'https://cdn.example/c.jpg' },
    ];
    assert.equal(tempUrlFromFileList(list, 'cloud://v'), '');
    assert.equal(tempUrlFromFileList(list, 'cloud://c'), 'https://cdn.example/c.jpg');
  });

  it('falls back to row at preferredIndex when fileID does not match', () => {
    const list = [{ fileID: 'cloud://other', status: 0, tempFileURL: 'https://cdn.example/v.mp4' }];
    assert.equal(tempUrlFromFileList(list, 'cloud://v', 0), 'https://cdn.example/v.mp4');
  });
});

describe('resolveMediaUrls', () => {
  it('calls getTempFileURL once with video and cover ids and maps HTTPS urls', async () => {
    const calls = [];
    const getTempFileURL = async (payload) => {
      calls.push(payload);
      return {
        fileList: [
          { fileID: 'cloud://v', status: 0, tempFileURL: 'https://cdn.example/v.mp4' },
          { fileID: 'cloud://c', status: 0, tempFileURL: 'https://cdn.example/c.jpg' },
        ],
      };
    };
    const out = await resolveMediaUrls(
      { videoFileId: 'cloud://v', coverFileId: 'cloud://c' },
      getTempFileURL,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].fileList, [
      { fileID: 'cloud://v', maxAge: 86400 },
      { fileID: 'cloud://c', maxAge: 86400 },
    ]);
    assert.deepEqual(out, {
      videoUrl: 'https://cdn.example/v.mp4',
      posterUrl: 'https://cdn.example/c.jpg',
    });
  });

  it('throws MEDIA_URL_FAIL with errMsg when video file cannot be resolved', async () => {
    const getTempFileURL = async () => ({
      fileList: [{ fileID: 'cloud://v', status: -503002, tempFileURL: '', errMsg: 'STORAGE_EXCEED_AUTHORITY' }],
    });
    await assert.rejects(
      () => resolveMediaUrls({ videoFileId: 'cloud://v', coverFileId: '' }, getTempFileURL),
      (err) => err.code === 'MEDIA_URL_FAIL' && /STORAGE_EXCEED_AUTHORITY/.test(err.message),
    );
  });

  it('still resolves video when response fileID string differs but index 0 succeeds', async () => {
    const getTempFileURL = async () => ({
      fileList: [{ fileID: 'cloud://v-rewritten', status: 0, tempFileURL: 'https://cdn.example/v.mp4' }],
    });
    const out = await resolveMediaUrls({ videoFileId: 'cloud://v', coverFileId: '' }, getTempFileURL);
    assert.equal(out.videoUrl, 'https://cdn.example/v.mp4');
  });

  it('skips getTempFileURL when there is no video file id', async () => {
    let called = false;
    const out = await resolveMediaUrls({ videoFileId: '', coverFileId: 'cloud://c' }, async () => {
      called = true;
      return { fileList: [] };
    });
    assert.equal(called, false);
    assert.deepEqual(out, { videoUrl: '', posterUrl: '' });
  });
});
