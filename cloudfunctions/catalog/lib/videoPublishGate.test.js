'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  assertVideoDraftFields,
  assertReadyToPublish,
  isReadyToPublish,
  nextStatusAfterSave,
} = require('./videoPublishGate');
const { searchPublished, buildSearchBlob } = require('./catalogSearch');

describe('videoPublishGate', () => {
  it('rejects upsert-shaped payload without intro', () => {
    assert.throws(
      () => assertVideoDraftFields({ title: '主机架设', brandId: 'b1', intro: '  ' }),
      (err) => err.code === 'BAD_INPUT',
    );
  });

  it('rejects publish when cover or video is missing', () => {
    const doc = {
      title: '主机架设',
      intro: '对中讲解',
      brandId: 'b1',
      coverFileId: 'cloud://c',
      videoFileId: '',
    };
    assert.equal(isReadyToPublish(doc), false);
    assert.throws(() => assertReadyToPublish(doc), (err) => err.code === 'BAD_INPUT');
  });

  it('accepts publish when title intro cover and video are present', () => {
    assert.equal(
      isReadyToPublish({
        title: '主机架设',
        intro: '对中讲解',
        brandId: 'b1',
        coverFileId: 'cloud://c',
        videoFileId: 'cloud://v',
      }),
      true,
    );
  });

  it('keeps unpublished out of searchPublished', () => {
    const video = {
      _id: 'u1',
      status: 'unpublished',
      title: '主机架设',
      brandName: '中海达',
      modelName: 'iRTK5',
      intro: '对中',
      tags: [],
      searchBlob: buildSearchBlob({
        title: '主机架设',
        intro: '对中',
        brandName: '中海达',
        modelName: 'iRTK5',
        tags: [],
      }),
      publishedAt: 9,
    };
    assert.deepEqual(searchPublished([video], '主机架设', []), []);
  });

  it('preserves unpublished on save', () => {
    assert.equal(nextStatusAfterSave('unpublished'), 'unpublished');
    assert.equal(nextStatusAfterSave('published'), 'published');
    assert.equal(nextStatusAfterSave('draft'), 'draft');
  });
});
