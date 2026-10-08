'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { publicVideo } = require('./publicVideo');

describe('publicVideo', () => {
  it('omits ingest and transcript from the public projection', () => {
    const video = publicVideo({
      _id: '1',
      title: 't',
      intro: 'i',
      brandId: 'b',
      brandName: '南',
      status: 'published',
      ingest: { phase: 'ready' },
      transcriptSegments: [{ startSec: 0, endSec: 1, text: '密' }],
      transcript: '密',
    });
    assert.equal(video.ingest, undefined);
    assert.equal(video.transcriptSegments, undefined);
    assert.equal(video.transcript, undefined);
    assert.equal(video.title, 't');
  });
});
