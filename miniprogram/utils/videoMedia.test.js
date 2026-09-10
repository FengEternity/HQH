'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { withPosterUrl, withPosterUrls, planVideoCoverUpload } = require('./videoMedia');

describe('withPosterUrl', () => {
  it('does not use cloud:// coverFileId as image src', () => {
    const out = withPosterUrl({
      _id: 'v1',
      title: '测试',
      coverFileId: 'cloud://env/cover/a.jpg',
    });
    assert.equal(out.posterUrl, '');
    assert.equal(out.coverFileId, 'cloud://env/cover/a.jpg');
  });

  it('drops a cloud:// posterUrl leftover', () => {
    const out = withPosterUrl({
      coverFileId: 'cloud://env/cover/a.jpg',
      posterUrl: 'cloud://env/cover/a.jpg',
    });
    assert.equal(out.posterUrl, '');
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
    assert.equal(list[0].posterUrl, '');
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
