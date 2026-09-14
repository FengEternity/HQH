'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeVideoMedia } = require('./videoMediaMetadata');

describe('normalizeVideoMedia', () => {
  it('rounds durationSec to one decimal place', () => {
    const out = normalizeVideoMedia({ durationSec: 65.44 });
    assert.equal(out.durationSec, 65.4);
    const out2 = normalizeVideoMedia({ durationSec: 65.46 });
    assert.equal(out2.durationSec, 65.5);
  });

  it('lowercases codec strings and accepts boolean hasAudio', () => {
    const withAudio = normalizeVideoMedia({
      durationSec: 10,
      media: { videoCodec: 'H264', audioCodec: 'AAC', hasAudio: true },
    });
    assert.deepEqual(withAudio.media, {
      videoCodec: 'h264',
      audioCodec: 'aac',
      hasAudio: true,
    });
    const withoutAudio = normalizeVideoMedia({
      durationSec: 10,
      media: { videoCodec: 'H264', audioCodec: 'AAC', hasAudio: false },
    });
    assert.deepEqual(withoutAudio.media, {
      videoCodec: 'h264',
      audioCodec: 'aac',
      hasAudio: false,
    });
  });

  it('rejects non-boolean hasAudio when explicitly provided', () => {
    assert.throws(
      () => normalizeVideoMedia({
        durationSec: 10,
        media: { videoCodec: 'h264', audioCodec: 'aac', hasAudio: 1 },
      }),
      (error) => error.code === 'BAD_INPUT',
    );
    assert.throws(
      () => normalizeVideoMedia({
        durationSec: 10,
        media: { videoCodec: 'h264', audioCodec: 'aac', hasAudio: 'false' },
      }),
      (error) => error.code === 'BAD_INPUT',
    );
  });

  it('rejects negative durationSec', () => {
    assert.throws(
      () => normalizeVideoMedia({ durationSec: -0.1 }),
      (error) => error.code === 'BAD_INPUT',
    );
  });

  it('rejects extra media fields outside the contract', () => {
    assert.throws(
      () => normalizeVideoMedia({
        durationSec: 1,
        media: { videoCodec: 'h264', width: 1280 },
      }),
      (error) => error.code === 'BAD_INPUT',
    );
    assert.throws(
      () => normalizeVideoMedia({
        durationSec: 1,
        media: { videoCodec: 'h264', fps: 30 },
      }),
      (error) => error.code === 'BAD_INPUT',
    );
    assert.throws(
      () => normalizeVideoMedia({
        durationSec: 1,
        media: { videoCodec: 'h264', sourceBytes: 1024 },
      }),
      (error) => error.code === 'BAD_INPUT',
    );
  });

  it('preserves previous media metadata when admin omits durationSec and media', () => {
    const previous = {
      durationSec: 72.3,
      media: { videoCodec: 'h264', audioCodec: 'aac', hasAudio: true },
    };
    const out = normalizeVideoMedia({}, previous);
    assert.deepEqual(out, previous);
  });

  it('defaults to zero duration and empty codecs when no input and no previous', () => {
    const out = normalizeVideoMedia({});
    assert.equal(out.durationSec, 0);
    assert.deepEqual(out.media, {
      videoCodec: '',
      audioCodec: '',
      hasAudio: false,
    });
  });

  it('updates durationSec alone while preserving previous media', () => {
    const previous = {
      durationSec: 72.3,
      media: { videoCodec: 'h264', audioCodec: 'aac', hasAudio: true },
    };
    const out = normalizeVideoMedia({ durationSec: 80.05 }, previous);
    assert.equal(out.durationSec, 80.1);
    assert.deepEqual(out.media, previous.media);
  });

  it('updates media alone while preserving previous durationSec', () => {
    const previous = {
      durationSec: 72.3,
      media: { videoCodec: 'h264', audioCodec: 'aac', hasAudio: true },
    };
    const out = normalizeVideoMedia({
      media: { videoCodec: 'HEVC', audioCodec: 'AAC', hasAudio: false },
    }, previous);
    assert.equal(out.durationSec, 72.3);
    assert.deepEqual(out.media, {
      videoCodec: 'hevc',
      audioCodec: 'aac',
      hasAudio: false,
    });
  });

  it('rejects non-finite durationSec', () => {
    assert.throws(
      () => normalizeVideoMedia({ durationSec: NaN }),
      (error) => error.code === 'BAD_INPUT',
    );
    assert.throws(
      () => normalizeVideoMedia({ durationSec: Infinity }),
      (error) => error.code === 'BAD_INPUT',
    );
  });
});
