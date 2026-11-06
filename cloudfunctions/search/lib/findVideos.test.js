'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { findVideos } = require('./findVideos');

const cors = {
  _id: 'cors',
  status: 'published',
  title: '南方CORS设置',
  intro: '演示南方手簿 CORS 连接与账号设置。',
  searchAbstract: '',
  brandName: '南方',
  brandId: 'b-south',
  modelName: '',
  tags: ['CORS'],
  coverFileId: 'cloud://cover-cors',
  searchBlob: '南方cors设置 演示南方手簿 cors 连接与账号设置。 南方 cors',
};

describe('findVideos', () => {
  it('hits a rewritten phrase and misses the original sentence', () => {
    assert.equal(findVideos([cors], '怎么设置账号', []).length, 0);
    const cards = findVideos([cors], '账号设置', []);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].id, 'cors');
    assert.equal(cards[0].summary, '演示南方手簿 CORS 连接与账号设置。');
    assert.equal(cards[0].coverFileId, 'cloud://cover-cors');
    assert.equal(cards[0].brandId, 'b-south');
    assert.equal(cards[0].score, undefined);
  });

  it('expands synonyms before matching the whole phrase', () => {
    const cards = findVideos([cors], ' Cors 账号 ', [{ alias: ' cors ', canonical: 'cors' }]);
    assert.equal(cards.length, 0);
    const hit = findVideos([cors], '账号设置', []);
    assert.equal(hit.length, 1);
  });

  it('returns at most 8 cards and skips drafts', () => {
    const videos = [];
    for (let index = 0; index < 9; index += 1) {
      videos.push(Object.assign({}, cors, { _id: 'v' + index }));
    }
    videos.push(Object.assign({}, cors, { _id: 'draft', status: 'draft' }));
    const cards = findVideos(videos, '账号设置', []);
    assert.equal(cards.length, 8);
    assert.equal(cards.some((card) => card.id === 'draft'), false);
  });

  it('falls back to searchAbstract when there is no intro', () => {
    const noIntro = Object.assign({}, cors, { intro: '', searchAbstract: 'CORS 摘要' });
    const cards = findVideos([noIntro], '账号设置', []);
    assert.equal(cards[0].summary, 'CORS 摘要');
  });
});
