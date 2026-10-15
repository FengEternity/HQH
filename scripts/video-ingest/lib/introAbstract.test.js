'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const {
  INTRO_SYSTEM_PROMPT,
  acceptIntro,
  buildIntroUserPrompt,
  hasHomophone,
} = require('./introAbstract');

const PLACEHOLDER_INTRO = '讲解处理中，完成后请核对简介。';
const termsDocument = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'terms.zh-CN.json'), 'utf8'),
);
const examples = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'intro-abstract.examples.json'), 'utf8'),
);

function acceptExample(example, intro) {
  return acceptIntro({
    intro,
    title: example.title,
    brandName: example.brandName,
    transcript: example.transcript,
    terms: termsDocument.terms,
    brandNames: termsDocument.brandNames,
    placeholderIntro: PLACEHOLDER_INTRO,
  });
}

describe('acceptIntro', () => {
  it('接受三则认可稿', () => {
    for (const example of examples) {
      const verdict = acceptExample(example, example.intro);
      assert.equal(verdict.ok, true, example.title);
      assert.equal(verdict.intro, example.intro);
    }
  });

  it('手簿可由手部同音放行，地物可由地雾同音放行', () => {
    assert.equal(hasHomophone('手部连接上电脑', '手簿'), true);
    assert.equal(hasHomophone('选择地雾测量', '地物'), true);
    assert.equal(hasHomophone('千询的仪器', '千寻仪器'), true);
    assert.equal(hasHomophone('完全没有提到手持设备', '手簿'), false);
  });

  it('繁体寻和子务线可以对上术语', () => {
    assert.equal(hasHomophone('一起学习千尋c7手部如何升级', '千寻C7手簿'), true);
    assert.equal(hasHomophone('获取到当地中央子务线点击确认', '中央子午线'), true);
  });

  it('超过四句但未超过一百六十字时仍接受', () => {
    const example = examples[2];
    const intro = example.intro.replace(/，/g, '。');
    const verdict = acceptExample(example, intro);
    assert.equal(verdict.ok, true, verdict.reason);
  });

  it('数据导入口播上拒绝格式、连接方式和片尾', () => {
    const example = examples[0];
    const base = example.intro;
    for (const intro of [
      base.replace('CSV', 'dat/txt'),
      `${base.slice(0, 50)}有线或无线均可导入。`,
      `${base.slice(0, 50)}支持一键导入控制点。`,
      `${base}别忘了点赞并转发`,
      '千寻数据导入。',
    ]) {
      assert.equal(acceptExample(example, intro).ok, false, intro);
    }
  });

  it('去掉模型加上的前缀后仍可验收', () => {
    const example = examples[0];
    const verdict = acceptExample(example, `简介：${example.intro}`);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.intro, example.intro);
  });
});

describe('buildIntroUserPrompt', () => {
  it('带上品牌、术语和口播，不写占位句', () => {
    const example = examples[0];
    const prompt = buildIntroUserPrompt({
      title: example.title,
      brandName: example.brandName,
      transcript: example.transcript,
      terms: termsDocument.terms,
    });
    assert.equal(prompt.includes(`品牌：${example.brandName}`), true);
    assert.equal(prompt.includes('手簿'), true);
    assert.equal(prompt.includes(example.transcript), true);
    assert.equal(prompt.includes(PLACEHOLDER_INTRO), false);
    assert.equal(INTRO_SYSTEM_PROMPT.includes('主要操作'), true);
  });
});
