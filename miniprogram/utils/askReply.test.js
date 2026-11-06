'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatAskRuns } = require('./askReply');

function plain(runs) {
  return runs.map((run) => run.text).join('');
}

describe('ask reply formatting', () => {
  it('renders bold, lists, and paragraph gaps without markdown source', () => {
    const runs = formatAskRuns([
      '按这个顺序操作：',
      '',
      '1. 打开 **High Survey**',
      '2. 点击 **一键固定**',
      '',
      '- 没有在售商品',
    ].join('\n'));
    const text = plain(runs);
    assert.equal(text.includes('**'), false);
    assert.equal(text.includes('`'), false);
    assert.match(text, /^按这个顺序操作：\n\n1\. 打开 High Survey\n2\. 点击 一键固定\n\n• 没有在售商品$/);
    assert.equal(runs.find((run) => run.text === 'High Survey').strong, true);
    assert.equal(runs.find((run) => run.text === '一键固定').strong, true);
  });

  it('hides an unclosed bold marker and backticks while the answer is still arriving', () => {
    const runs = formatAskRuns('打开 **High Survey\n`products`');
    assert.equal(plain(runs), '打开 High Survey\nproducts');
    assert.equal(runs.some((run) => run.strong), false);
  });

  it('hides tool leaks and field labels already stored in a reply', () => {
    const runs = formatAskRuns([
      '根据当前这条讲解视频的信息，**没有关联的上架商品**（工具返回的 `products` 为空数组），也没有返回任何关联的其他视频。',
      '',
      '当前视频信息如下：',
      '- **标题**：中海达仪器一键固定设置',
      '- **简介**：在手簿软件配置基准、差分等参数。',
      '- **品牌**：中海达',
      '- **讲解内容**：打开 **High Survey** → 点击 **一键固定**',
    ].join('\n'));
    const text = plain(runs);
    assert.equal(text.includes('工具'), false);
    assert.equal(text.includes('products'), false);
    assert.equal(text.includes('**'), false);
    assert.equal(text.includes('标题'), false);
    assert.equal(text.includes('High Survey'), true);
    assert.equal(runs.find((run) => run.text === 'High Survey').strong, true);
    assert.equal(runs.find((run) => run.text === '一键固定').strong, true);
  });

  it('drops a fenced block and keeps the sentence', () => {
    const runs = formatAskRuns('先整平。\n```json\n{"cards":[]}\n```');
    assert.equal(plain(runs), '先整平。');
  });
});
