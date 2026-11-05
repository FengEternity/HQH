'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { attachAvatarUrls } = require('./resolveAvatarUrls');

describe('attachAvatarUrls', () => {
  it('把 cloud:// 头像换成临时 HTTPS，同一文件只换一次', async () => {
    const calls = [];
    const getTempFileURL = async (payload) => {
      calls.push(payload);
      return {
        fileList: [
          { fileID: 'cloud://a', status: 0, tempFileURL: 'https://cdn.example/a.jpg' },
        ],
      };
    };
    const out = await attachAvatarUrls(
      [
        { _id: '1', avatarFileId: 'cloud://a', nickname: '暮春雪' },
        { _id: '2', avatarFileId: 'cloud://a', nickname: '暮春雪' },
        { _id: '3', avatarFileId: '', nickname: '胡勤杭' },
      ],
      getTempFileURL,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].fileList, [{ fileID: 'cloud://a', maxAge: 86400 }]);
    assert.equal(out[0].avatarFileId, 'cloud://a');
    assert.equal(out[0].avatarUrl, 'https://cdn.example/a.jpg');
    assert.equal(out[1].avatarUrl, 'https://cdn.example/a.jpg');
    assert.equal(out[2].avatarUrl, '');
  });

  it('换链被拒绝或抛错时留空，页面可以退回首字', async () => {
    const denied = await attachAvatarUrls(
      [{ avatarFileId: 'cloud://a' }],
      async () => ({
        fileList: [{ fileID: 'cloud://a', status: -503002, tempFileURL: '', errMsg: 'STORAGE_EXCEED_AUTHORITY' }],
      }),
    );
    assert.equal(denied[0].avatarUrl, '');

    const thrown = await attachAvatarUrls(
      [{ avatarFileId: 'cloud://a' }],
      async () => {
        throw new Error('network');
      },
    );
    assert.equal(thrown[0].avatarUrl, '');
    assert.equal(thrown[0].avatarFileId, 'cloud://a');
  });

  it('没有头像时不调用换链', async () => {
    let called = false;
    const out = await attachAvatarUrls([{ avatarFileId: '' }, {}], async () => {
      called = true;
      return { fileList: [] };
    });
    assert.equal(called, false);
    assert.deepEqual(
      out.map((item) => item.avatarUrl),
      ['', ''],
    );
  });
});
