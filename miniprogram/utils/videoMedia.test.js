'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  withPosterUrl,
  withPosterUrls,
  planVideoCoverUpload,
  cloudUploadOptions,
  VIDEO_UPLOAD_TIMEOUT_MS,
} = require('./videoMedia');

describe('withPosterUrl', () => {
  it('fills posterUrl from coverFileId when posterUrl is missing', () => {
    const out = withPosterUrl({
      _id: 'v1',
      title: '测试',
      coverFileId: 'cloud://env/cover/a.jpg',
    });
    assert.equal(out.posterUrl, 'cloud://env/cover/a.jpg');
    assert.equal(out.coverFileId, 'cloud://env/cover/a.jpg');
  });

  it('keeps an existing posterUrl', () => {
    const out = withPosterUrl({
      coverFileId: 'cloud://env/cover/a.jpg',
      posterUrl: 'https://tmp.example/a.jpg',
    });
    assert.equal(out.posterUrl, 'https://tmp.example/a.jpg');
  });

  it('returns empty posterUrl when both are missing', () => {
    assert.equal(withPosterUrl({ title: '无封面' }).posterUrl, '');
  });
});

describe('withPosterUrls', () => {
  it('maps a list of videos', () => {
    const list = withPosterUrls([
      { _id: '1', coverFileId: 'cloud://c1' },
      { _id: '2', coverFileId: '', posterUrl: '' },
    ]);
    assert.equal(list[0].posterUrl, 'cloud://c1');
    assert.equal(list[1].posterUrl, '');
  });
});

describe('planVideoCoverUpload', () => {
  it('keeps existing cover and skips thumb upload', () => {
    assert.deepEqual(
      planVideoCoverUpload({ coverFileId: 'cloud://c', thumbTempFilePath: '/tmp/t.jpg' }),
      { action: 'keep' },
    );
  });

  it('uploads thumb when no cover yet', () => {
    assert.deepEqual(
      planVideoCoverUpload({ coverFileId: '', thumbTempFilePath: '/tmp/t.jpg' }),
      { action: 'upload_thumb', path: '/tmp/t.jpg' },
    );
  });

  it('reports missing thumb when WeChat did not provide one', () => {
    assert.deepEqual(
      planVideoCoverUpload({ coverFileId: '', thumbTempFilePath: '' }),
      { action: 'missing_thumb' },
    );
  });
});

describe('cloudUploadOptions', () => {
  it('gives video uploads longer than the 60s wx.uploadFile default', () => {
    assert.ok(VIDEO_UPLOAD_TIMEOUT_MS > 60 * 1000);
    assert.deepEqual(
      cloudUploadOptions({
        kind: 'video',
        cloudPath: 'video/a.mp4',
        filePath: '/tmp/a.mp4',
      }),
      {
        cloudPath: 'video/a.mp4',
        filePath: '/tmp/a.mp4',
        timeout: VIDEO_UPLOAD_TIMEOUT_MS,
      },
    );
  });

  it('leaves cover uploads on the platform default timeout', () => {
    assert.deepEqual(
      cloudUploadOptions({
        kind: 'cover',
        cloudPath: 'cover/a.jpg',
        filePath: '/tmp/a.jpg',
      }),
      {
        cloudPath: 'cover/a.jpg',
        filePath: '/tmp/a.jpg',
      },
    );
  });

  it('matches app.json uploadFile timeout so unset callers are not stuck at 60s', () => {
    const app = JSON.parse(fs.readFileSync(path.join(__dirname, '../app.json'), 'utf8'));
    assert.equal(app.networkTimeout.uploadFile, VIDEO_UPLOAD_TIMEOUT_MS);
  });
});
