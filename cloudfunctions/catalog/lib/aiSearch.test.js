'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  cosine,
  videoIndexText,
  excerpt,
  formatStartLabel,
  sanitizeStartSec,
  filterIndexByBrand,
  mergeVideoScores,
  applyLlmPicks,
  runAiSearch,
} = require('./aiSearch');

describe('cosine', () => {
  it('returns 1 for identical vectors', () => {
    assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
  });
  it('returns 0 for orthogonal or mismatched length', () => {
    assert.equal(cosine([1, 0], [0, 1]), 0);
    assert.equal(cosine([1], [1, 2]), 0);
  });
});

describe('videoIndexText', () => {
  it('prefers searchAbstract', () => {
    assert.equal(
      videoIndexText({ searchAbstract: '摘要', title: 't', intro: 'i', transcript: 'x'.repeat(20) }),
      '摘要',
    );
  });
  it('falls back and truncates', () => {
    const text = videoIndexText({ title: 'T', intro: 'I', transcript: 'X'.repeat(9000) });
    assert.equal(text.length, 8000);
    assert.ok(text.startsWith('T\nI\nXXX'));
  });
});

describe('sanitizeStartSec', () => {
  it('keeps a candidate second and drops invented ones', () => {
    assert.equal(sanitizeStartSec(12, [3, 12, 40]), 12);
    assert.equal(sanitizeStartSec(99, [3, 12]), 3);
    assert.equal(sanitizeStartSec(5, []), 0);
  });
});

describe('mergeVideoScores', () => {
  it('uses 0.6 video + 0.4 best segment when both exist', () => {
    const merged = mergeVideoScores(
      [{ _id: 'v1', score: 1 }],
      [{ videoId: 'v1', startSec: 10, text: 'a', score: 0.5 }],
    );
    assert.equal(merged.length, 1);
    assert.ok(Math.abs(merged[0].score - (0.6 * 1 + 0.4 * 0.5)) < 1e-9);
  });
  it('keeps segment-only videos with videoScore 0', () => {
    const merged = mergeVideoScores([], [{ videoId: 'v2', startSec: 1, text: 'b', score: 1 }]);
    assert.equal(merged[0].videoId, 'v2');
    assert.ok(Math.abs(merged[0].score - 0.4) < 1e-9);
  });
});

describe('filterIndexByBrand', () => {
  it('keeps only matching brand videos and their segments', () => {
    const index = {
      videos: [{ _id: 'a' }, { _id: 'b' }],
      segments: [
        { videoId: 'a', startSec: 0 },
        { videoId: 'b', startSec: 1 },
      ],
    };
    const catalog = [
      { _id: 'a', brandId: 'b1' },
      { _id: 'b', brandId: 'b2' },
    ];
    const out = filterIndexByBrand(index, catalog, 'b1');
    assert.deepEqual(
      out.videos.map((item) => item._id),
      ['a'],
    );
    assert.equal(out.segments.length, 1);
    assert.equal(out.segments[0].videoId, 'a');
  });
});

describe('applyLlmPicks', () => {
  it('drops invented startSec', () => {
    const ranked = [
      {
        videoId: 'v1',
        intro: '简介',
        segments: [{ startSec: 8, text: '切片八秒' }],
        bestSegment: { startSec: 8, text: '切片八秒' },
      },
    ];
    const out = applyLlmPicks(ranked, [{ _id: 'v1', reason: '因为参数', startSec: 999 }]);
    assert.equal(out[0].startSec, 8);
    assert.equal(out[0].reason, '因为参数');
    assert.equal(out[0].excerpt, '切片八秒');
  });
});

describe('labels', () => {
  it('formats clock and excerpt', () => {
    assert.equal(formatStartLabel(75), '约 1:15');
    assert.equal(formatStartLabel(0), '约 0:00');
    assert.equal(formatStartLabel(null), '');
    assert.equal(excerpt('一二三四五六七八九十', 4), '一二三四');
  });
});

describe('runAiSearch', () => {
  const catalogVideos = [
    {
      _id: 'v1',
      status: 'published',
      title: '参数计算',
      intro: '坐标系转换',
      brandId: 'b1',
      brandName: '海星达',
      posterUrl: '',
      tags: [],
    },
  ];
  const index = {
    videos: [{ _id: 'v1', vector: [1, 0], text: '参数' }],
    segments: [{ _id: 'v1:12', videoId: 'v1', startSec: 12, endSec: 20, text: '点击参数计算', vector: [0.9, 0.1] }],
  };

  it('rejects empty query', async () => {
    const out = await runAiSearch({ query: '  ' });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'BAD_INPUT');
  });

  it('rejects missing index', async () => {
    const out = await runAiSearch({ query: '怎么算参数', index: { videos: [] } });
    assert.equal(out.code, 'NO_INDEX');
  });

  it('continues when rewrite fails and sanitizes startSec', async () => {
    const out = await runAiSearch({
      query: '怎么算参数',
      index,
      catalogVideos,
      chatJson: async ({ user }) => {
        if (typeof user === 'string' && user.indexOf('candidates') >= 0) {
          return { answer: '讲参数计算', picks: [{ _id: 'v1', reason: '命中', startSec: 404 }] };
        }
        throw new Error('rewrite down');
      },
      embedTexts: async () => [[1, 0]],
    });
    assert.equal(out.ok, true);
    assert.equal(out.videos[0]._id, 'v1');
    assert.equal(out.videos[0].startSec, 12);
    assert.equal(out.answer, '讲参数计算');
    assert.ok(!JSON.stringify(out).includes('transcript'));
  });

  it('fails closed on embed error', async () => {
    const out = await runAiSearch({
      query: 'x',
      index,
      catalogVideos,
      chatJson: async () => ({ query: 'x' }),
      embedTexts: async () => {
        throw new Error('no embed');
      },
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'EMBED_FAIL');
  });
});
