'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeVideoKnowledge } = require('./videoKnowledge');

describe('normalizeVideoKnowledge', () => {
  it('normalizes ordered segments and derives transcript', () => {
    const out = normalizeVideoKnowledge({
      transcriptSegments: [
        { startSec: 1.2, endSec: 2.8, text: ' 打开项目 ' },
        { startSec: 3, endSec: 4, text: '点击测量' },
      ],
    });
    assert.deepEqual(out.transcriptSegments, [
      { startSec: 1.2, endSec: 2.8, text: '打开项目' },
      { startSec: 3, endSec: 4, text: '点击测量' },
    ]);
    assert.equal(out.transcript, '打开项目\n点击测量');
  });

  it('rejects a conflicting handwritten transcript', () => {
    assert.throws(
      () => normalizeVideoKnowledge({
        transcriptSegments: [{ startSec: 0, endSec: 1, text: '打开项目' }],
        transcript: '另一份全文',
      }),
      (error) => error.code === 'BAD_INPUT',
    );
  });

  it('accepts transcript when it matches derived text', () => {
    const out = normalizeVideoKnowledge({
      transcriptSegments: [{ startSec: 0, endSec: 1, text: '打开项目' }],
      transcript: '打开项目',
    });
    assert.equal(out.transcript, '打开项目');
  });

  it('treats transcript undefined as not provided and derives from segments', () => {
    const out = normalizeVideoKnowledge({
      transcriptSegments: [{ startSec: 0, endSec: 1, text: '打开项目' }],
      transcript: undefined,
    });
    assert.equal(out.transcript, '打开项目');
  });

  it('derives empty transcript from empty segments', () => {
    const out = normalizeVideoKnowledge({ transcriptSegments: [] });
    assert.deepEqual(out.transcriptSegments, []);
    assert.equal(out.transcript, '');
  });

  it('rejects negative startSec', () => {
    assert.throws(
      () => normalizeVideoKnowledge({
        transcriptSegments: [{ startSec: -0.1, endSec: 1, text: '打开项目' }],
      }),
      (error) => error.code === 'BAD_INPUT',
    );
  });

  it('rejects endSec not greater than startSec', () => {
    assert.throws(
      () => normalizeVideoKnowledge({
        transcriptSegments: [{ startSec: 1, endSec: 1, text: '打开项目' }],
      }),
      (error) => error.code === 'BAD_INPUT',
    );
    assert.throws(
      () => normalizeVideoKnowledge({
        transcriptSegments: [{ startSec: 2, endSec: 1.5, text: '打开项目' }],
      }),
      (error) => error.code === 'BAD_INPUT',
    );
  });

  it('rejects out-of-order segments', () => {
    assert.throws(
      () => normalizeVideoKnowledge({
        transcriptSegments: [
          { startSec: 3, endSec: 4, text: '点击测量' },
          { startSec: 1, endSec: 2, text: '打开项目' },
        ],
      }),
      (error) => error.code === 'BAD_INPUT',
    );
  });

  it('rejects empty text after trim', () => {
    assert.throws(
      () => normalizeVideoKnowledge({
        transcriptSegments: [{ startSec: 0, endSec: 1, text: '   ' }],
      }),
      (error) => error.code === 'BAD_INPUT',
    );
  });

  it('rejects non-finite startSec or endSec', () => {
    assert.throws(
      () => normalizeVideoKnowledge({
        transcriptSegments: [{ startSec: NaN, endSec: 1, text: '打开项目' }],
      }),
      (error) => error.code === 'BAD_INPUT',
    );
    assert.throws(
      () => normalizeVideoKnowledge({
        transcriptSegments: [{ startSec: 0, endSec: Infinity, text: '打开项目' }],
      }),
      (error) => error.code === 'BAD_INPUT',
    );
  });
});
