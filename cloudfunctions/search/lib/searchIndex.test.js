'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildSearchBlob } = require('./keywordSearch');
const { runSearch } = require('./searchIndex');

const synonyms = [
  { alias: '中海达', canonical: '中海达' },
  { alias: 'hi-target', canonical: '中海达' },
  { alias: '华测', canonical: '华测' },
  { alias: 'chcnav', canonical: '华测' },
];

function publishedVideo(overrides) {
  const base = {
    _id: 'v1',
    status: 'published',
    title: '主机架设',
    intro: '',
    brandId: 'b1',
    brandName: '中海达',
    modelName: 'iRTK5',
    tags: ['对中'],
    coverFileId: 'cloud://cover',
    publishedAt: 2,
  };
  const video = Object.assign(base, overrides || {});
  video.searchBlob = buildSearchBlob(video);
  return video;
}

describe('runSearch', () => {
  it('rejects illegal scene with BAD_INPUT and no message', () => {
    const res = runSearch({ scene: 'cs', query: '对中' });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'BAD_INPUT');
    assert.equal(res.message, undefined);
  });

  it('returns empty items for blank video query', () => {
    const res = runSearch({
      scene: 'video',
      query: '   ',
      videos: [publishedVideo()],
      synonyms,
    });
    assert.deepEqual(res, { ok: true, scene: 'video', items: [] });
  });

  it('returns empty items when nothing is published', () => {
    const res = runSearch({
      scene: 'video',
      query: '主机架设',
      videos: [],
      synonyms,
    });
    assert.deepEqual(res, { ok: true, scene: 'video', items: [] });
  });

  it('reserves product scene as empty list', () => {
    const res = runSearch({ scene: 'product', query: '脚架' });
    assert.deepEqual(res, { ok: true, scene: 'product', items: [] });
  });

  it('keeps keyword hits and marks semantic search unavailable when the query vector is missing', () => {
    const video = publishedVideo();
    const res = runSearch({
      scene: 'video',
      query: 'hi-target iRTK5',
      videos: [video],
      synonyms,
    });
    assert.equal(res.notice, 'semantic_unavailable');
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].id, 'v1');
    assert.equal(res.items[0].score, undefined);
    assert.deepEqual(Object.keys(res.items[0]).sort(), [
      'brandId',
      'brandName',
      'coverFileId',
      'id',
      'modelName',
      'summary',
      'tags',
      'title',
      'type',
    ]);
  });

  it('omits draft when title matches', () => {
    const published = publishedVideo({ _id: 'pub', brandName: '华测', modelName: '', tags: [] });
    const draft = publishedVideo({
      _id: 'draft',
      status: 'draft',
      brandName: '华测',
      modelName: '',
      tags: [],
    });
    const res = runSearch({
      scene: 'video',
      query: '主机架设',
      videos: [published, draft],
      synonyms,
    });
    assert.deepEqual(
      res.items.map((item) => item.id),
      ['pub'],
    );
  });

  it('requires every token (AND)', () => {
    const video = publishedVideo({
      title: '主机架设',
      brandName: '华测',
      modelName: '',
      tags: [],
    });
    const miss = runSearch({
      scene: 'video',
      query: '华测 全站仪',
      videos: [video],
      synonyms,
    });
    assert.equal(miss.items.length, 0);
    assert.equal(miss.notice, 'semantic_unavailable');
    const hit = runSearch({
      scene: 'video',
      query: '华测 主机架设',
      videos: [video],
      synonyms,
    });
    assert.equal(hit.items.length, 1);
  });

  it('ranks title match above tag-only match and newer first when ranks tie', () => {
    const tagOnly = publishedVideo({
      _id: 'tag',
      title: '其他操作',
      intro: '简介里写对中',
      brandName: '华测',
      modelName: 'X',
      tags: ['对中'],
      publishedAt: 99,
    });
    const titleHitOld = publishedVideo({
      _id: 'title-old',
      title: '对中讲解',
      intro: '',
      brandName: '南方',
      modelName: 'A',
      tags: [],
      publishedAt: 1,
    });
    const titleHitNew = publishedVideo({
      _id: 'title-new',
      title: '对中讲解',
      intro: '',
      brandName: '南方',
      modelName: 'A',
      tags: [],
      publishedAt: 8,
    });
    const res = runSearch({
      scene: 'video',
      query: '对中',
      videos: [tagOnly, titleHitOld, titleHitNew],
      synonyms,
    });
    assert.deepEqual(
      res.items.map((item) => item.id),
      ['title-new', 'title-old', 'tag'],
    );
  });
});
