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

  it('only publishes the processed file after a compliant playback check', () => {
    const base = {
      title: '主机架设',
      intro: '对中讲解',
      brandId: 'b1',
      coverFileId: 'cloud://c',
      videoFileId: 'cloud://processed',
    };
    const ready = {
      ...base,
      ingest: { phase: 'ready', videoFileId: 'cloud://processed' },
      videoFileId: 'cloud://processed',
      media: { playback: { compliant: true } },
    };
    assert.equal(isReadyToPublish(ready), true);
    assert.equal(
      isReadyToPublish({ ...ready, ingest: { ...ready.ingest, phase: 'queued' } }),
      false,
    );
    assert.equal(
      isReadyToPublish({ ...ready, ingest: { ...ready.ingest, phase: 'running' } }),
      false,
    );
    assert.equal(
      isReadyToPublish({ ...ready, ingest: { ...ready.ingest, phase: 'failed' } }),
      false,
    );
    assert.equal(
      isReadyToPublish({
        ...ready,
        ingest: { ...ready.ingest, videoFileId: 'cloud://old' },
      }),
      false,
    );
    assert.equal(isReadyToPublish({ ...ready, media: {} }), false);
    assert.equal(isReadyToPublish(base), false);
  });

  it('rejects publish while the intro is still the processing placeholder', () => {
    const base = {
      title: '主机架设',
      brandId: 'b1',
      coverFileId: 'cloud://c',
      videoFileId: 'cloud://v',
      ingest: { phase: 'ready', videoFileId: 'cloud://v' },
      media: { playback: { compliant: true } },
    };
    assert.equal(
      isReadyToPublish({ ...base, intro: '讲解处理中，完成后请核对简介。' }),
      false,
    );
    assert.equal(isReadyToPublish({ ...base, intro: '对中讲解' }), true);
  });

  it('keeps the placeholder saveable as a draft', () => {
    assert.doesNotThrow(() =>
      assertVideoDraftFields({
        title: '主机架设',
        brandId: 'b1',
        intro: '讲解处理中，完成后请核对简介。',
      }),
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
