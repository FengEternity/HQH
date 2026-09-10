'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { tempUrlFromFileList, resolveMediaUrls, attachPosterUrls } = require('./resolveMediaUrls');

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

describe('attachPosterUrls', () => {
  it('maps unique coverFileId to HTTPS posterUrl and does not leave cloud:// as src', async () => {
    const calls = [];
    const getTempFileURL = async (payload) => {
      calls.push(payload);
      return {
        fileList: [
          { fileID: 'cloud://c1', status: 0, tempFileURL: 'https://cdn.example/c1.jpg' },
          { fileID: 'cloud://c2', status: 0, tempFileURL: 'https://cdn.example/c2.jpg' },
        ],
      };
    };
    const out = await attachPosterUrls(
      [
        { _id: 'v1', coverFileId: 'cloud://c1' },
        { _id: 'v2', coverFileId: 'cloud://c1' },
        { _id: 'v3', coverFileId: 'cloud://c2' },
        { _id: 'v4', coverFileId: '' },
      ],
      getTempFileURL,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].fileList, [
      { fileID: 'cloud://c1', maxAge: 86400 },
      { fileID: 'cloud://c2', maxAge: 86400 },
    ]);
    assert.equal(out[0].posterUrl, 'https://cdn.example/c1.jpg');
    assert.equal(out[1].posterUrl, 'https://cdn.example/c1.jpg');
    assert.equal(out[2].posterUrl, 'https://cdn.example/c2.jpg');
    assert.equal(out[3].posterUrl, '');
    assert.equal(out[0].coverFileId, 'cloud://c1');
  });

  it('leaves posterUrl empty when cover exchange fails instead of using cloud://', async () => {
    const out = await attachPosterUrls(
      [{ _id: 'v1', coverFileId: 'cloud://c1' }],
      async () => ({
        fileList: [{ fileID: 'cloud://c1', status: -503002, tempFileURL: '', errMsg: 'STORAGE_EXCEED_AUTHORITY' }],
      }),
    );
    assert.equal(out[0].posterUrl, '');
  });

  it('skips getTempFileURL when no cover ids', async () => {
    let called = false;
    const out = await attachPosterUrls([{ _id: 'v1', coverFileId: '' }], async () => {
      called = true;
      return { fileList: [] };
    });
    assert.equal(called, false);
    assert.equal(out[0].posterUrl, '');
  });

  it('batches more than 50 unique covers into multiple getTempFileURL calls', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `cloud://c${i}`);
    const calls = [];
    const getTempFileURL = async (payload) => {
      calls.push(payload.fileList.map((item) => item.fileID));
      return {
        fileList: payload.fileList.map((item) => ({
          fileID: item.fileID,
          status: 0,
          tempFileURL: `https://cdn.example/${item.fileID.slice(8)}.jpg`,
        })),
      };
    };
    const videos = ids.map((coverFileId, i) => ({ _id: `v${i}`, coverFileId }));
    const out = await attachPosterUrls(videos, getTempFileURL);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].length, 50);
    assert.equal(calls[1].length, 1);
    assert.equal(out[50].posterUrl, 'https://cdn.example/c50.jpg');
  });

  it('still returns videos with empty posterUrl when getTempFileURL throws', async () => {
    const out = await attachPosterUrls(
      [{ _id: 'v1', coverFileId: 'cloud://c1', title: '架设' }],
      async () => {
        throw new Error('network');
      },
    );
    assert.equal(out[0]._id, 'v1');
    assert.equal(out[0].title, '架设');
    assert.equal(out[0].posterUrl, '');
  });
});
