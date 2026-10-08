'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeVideoKnowledge,
  resolveVideoKnowledge,
} = require('./videoKnowledge');

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

  it('rejects endSec beyond durationSec', () => {
    assert.throws(
      () => normalizeVideoKnowledge({
        transcriptSegments: [{ startSec: 0, endSec: 12.6, text: '打开项目' }],
        durationSec: 12.5,
      }),
      (error) => error.code === 'BAD_INPUT',
    );
  });

  it('accepts endSec exactly at durationSec', () => {
    const out = normalizeVideoKnowledge({
      transcriptSegments: [{ startSec: 0, endSec: 12.5, text: '打开项目' }],
      durationSec: 12.5,
    });
    assert.equal(out.transcriptSegments[0].endSec, 12.5);
  });

  it('rejects startSec beyond durationSec', () => {
    assert.throws(
      () => normalizeVideoKnowledge({
        transcriptSegments: [{ startSec: 13, endSec: 14, text: '打开项目' }],
        durationSec: 12.5,
      }),
      (error) => error.code === 'BAD_INPUT',
    );
  });

  it('skips the upper bound when durationSec is unknown', () => {
    const out = normalizeVideoKnowledge({
      transcriptSegments: [{ startSec: 0, endSec: 99, text: '打开项目' }],
      durationSec: 0,
    });
    assert.equal(out.transcriptSegments[0].endSec, 99);
    assert.equal(
      normalizeVideoKnowledge({
        transcriptSegments: [{ startSec: 0, endSec: 99, text: '打开项目' }],
      }).transcript,
      '打开项目',
    );
  });
});

describe('resolveVideoKnowledge', () => {
  it('normalizes and bounds segments the event explicitly submits', () => {
    const out = resolveVideoKnowledge({
      event: {
        transcriptSegments: [{ startSec: 0, endSec: 2, text: ' 打开项目 ' }],
      },
      prevData: { transcriptSegments: [], transcript: '' },
      durationSec: 5,
    });
    assert.deepEqual(out.transcriptSegments, [
      { startSec: 0, endSec: 2, text: '打开项目' },
    ]);
    assert.equal(out.transcript, '打开项目');

    assert.throws(
      () => resolveVideoKnowledge({
        event: { transcriptSegments: [{ startSec: 0, endSec: 9, text: '打开项目' }] },
        prevData: null,
        durationSec: 5,
      }),
      (error) => error.code === 'BAD_INPUT',
    );
  });

  it('keeps legacy segments untouched when the event omits transcriptSegments', () => {
    // 旧管理端表单只提交标题/简介；库里可能存着不满足新校验的历史字幕，保存不能因此失败。
    const legacySegments = [
      { startSec: 5, endSec: 4, text: '倒挂的旧段' },
      { startSec: 1, endSec: 2, text: '  乱序的旧段  ' },
    ];
    const out = resolveVideoKnowledge({
      event: { title: '中海达点测量' },
      prevData: { transcriptSegments: legacySegments, transcript: '旧的手写全文' },
      durationSec: 3,
    });

    assert.deepEqual(out.transcriptSegments, legacySegments);
    assert.equal(out.transcript, '旧的手写全文');
  });

  it('ignores a transcript the event sends without segments', () => {
    const out = resolveVideoKnowledge({
      event: { transcript: '想绕过分段的手写全文' },
      prevData: { transcriptSegments: [{ startSec: 0, endSec: 1, text: '打开项目' }], transcript: '打开项目' },
      durationSec: 1,
    });

    assert.equal(out.transcript, '打开项目');
  });

  it('falls back to empty knowledge for a brand new draft', () => {
    const out = resolveVideoKnowledge({ event: {}, prevData: null, durationSec: 0 });
    assert.deepEqual(out.transcriptSegments, []);
    assert.equal(out.transcript, '');
  });
});
