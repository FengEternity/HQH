'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isReadyToPublish } = require('./videoPublishGate');

describe('videoPublishGate', () => {
  it('only enables publish for the processed file with compliant playback', () => {
    const ready = {
      title: '主机架设',
      intro: '对中讲解',
      brandId: 'b1',
      coverFileId: 'cloud://cover',
      videoFileId: 'cloud://processed',
      ingest: { phase: 'ready', videoFileId: 'cloud://processed' },
      media: { playback: { compliant: true } },
    };

    assert.equal(isReadyToPublish(ready), true);
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
    assert.equal(isReadyToPublish({ ...ready, ingest: undefined }), false);
    assert.equal(isReadyToPublish({ ...ready, media: {} }), false);
    assert.equal(isReadyToPublish({ ...ready, introReview: 'pending' }), false);
    assert.equal(isReadyToPublish({ ...ready, introReview: 'confirmed' }), true);
  });
});
