'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildSearchBlob, searchPublished } = require('./catalogSearch');

const synonyms = [
  { alias: '中海达', canonical: '中海达' },
  { alias: 'hi-target', canonical: '中海达' },
  { alias: '华测', canonical: '华测' },
  { alias: 'chcnav', canonical: '华测' },
];

describe('searchPublished', () => {
  it('hits published video when query uses brand synonym and model (AE1)', () => {
    const video = {
      _id: 'v1',
      status: 'published',
      title: '主机架设',
      brandName: '中海达',
      modelName: 'iRTK5',
      intro: '',
      tags: ['对中'],
      searchBlob: buildSearchBlob({
        title: '主机架设',
        intro: '',
        brandName: '中海达',
        modelName: 'iRTK5',
        tags: ['对中'],
      }),
      publishedAt: 2,
    };
    const hits = searchPublished([video], '中海达 iRTK5', synonyms);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]._id, 'v1');
  });

  it('omits draft when title matches (AE2)', () => {
    const published = {
      _id: 'pub',
      status: 'published',
      title: '主机架设',
      brandName: '华测',
      modelName: '',
      searchBlob: buildSearchBlob({
        title: '主机架设',
        intro: '',
        brandName: '华测',
        modelName: '',
        tags: [],
      }),
      publishedAt: 1,
    };
    const draft = {
      ...published,
      _id: 'draft',
      status: 'draft',
    };
    const hits = searchPublished([published, draft], '主机架设', synonyms);
    assert.deepEqual(
      hits.map((item) => item._id),
      ['pub']
    );
  });

  it('returns empty for unknown query (AE3)', () => {
    const video = {
      _id: 'v1',
      status: 'published',
      title: '主机架设',
      brandName: '华测',
      modelName: '',
      searchBlob: buildSearchBlob({
        title: '主机架设',
        intro: '',
        brandName: '华测',
        modelName: '',
        tags: [],
      }),
      publishedAt: 1,
    };
    const hits = searchPublished([video], '全站仪校准动画', synonyms);
    assert.equal(hits.length, 0);
  });

  it('ranks title match above tag-only match and newer first when ranks tie (R16)', () => {
    const tagOnly = {
      _id: 'tag',
      status: 'published',
      title: '其他操作',
      brandName: '华测',
      modelName: 'X',
      searchBlob: buildSearchBlob({
        title: '其他操作',
        intro: '简介里写对中',
        brandName: '华测',
        modelName: 'X',
        tags: ['对中'],
      }),
      publishedAt: 99,
    };
    const titleHitOld = {
      _id: 'title-old',
      status: 'published',
      title: '对中讲解',
      brandName: '南方',
      modelName: 'A',
      searchBlob: buildSearchBlob({
        title: '对中讲解',
        intro: '',
        brandName: '南方',
        modelName: 'A',
        tags: [],
      }),
      publishedAt: 1,
    };
    const titleHitNew = {
      ...titleHitOld,
      _id: 'title-new',
      publishedAt: 8,
    };
    const hits = searchPublished([tagOnly, titleHitOld, titleHitNew], '对中', synonyms);
    assert.deepEqual(
      hits.map((item) => item._id),
      ['title-new', 'title-old', 'tag']
    );
  });

  it('hits published video via searchAbstract', () => {
    const video = {
      _id: 'abs',
      status: 'published',
      title: '操作演示',
      brandName: '海星达',
      modelName: '',
      intro: '',
      tags: [],
      searchBlob: buildSearchBlob({
        title: '操作演示',
        intro: '',
        searchAbstract: '讲解手簿 AR 实景测量流程',
        brandName: '海星达',
        modelName: '',
        tags: [],
      }),
      publishedAt: 1,
    };
    const hits = searchPublished([video], 'AR 实景', synonyms);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]._id, 'abs');
  });

  it('returns empty for blank query', () => {
    assert.deepEqual(searchPublished([{ status: 'published' }], '   ', synonyms), []);
  });
});
