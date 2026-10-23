'use strict';

const fs = require('fs');
const path = require('path');
const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../../../utils/api');
const pagePath = require.resolve('./models');
const originalPage = global.Page;
const originalWx = global.wx;

function loadPage(agent) {
  delete require.cache[pagePath];
  const api = require(apiPath);
  const previous = api.agent;
  api.agent = agent;
  let definition;
  global.Page = (value) => {
    definition = value;
  };
  require(pagePath);
  api.agent = previous;
  return Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(next) {
      this.data = Object.assign({}, this.data, next);
    },
  });
}

afterEach(() => {
  delete require.cache[pagePath];
  global.Page = originalPage;
  global.wx = originalWx;
});

describe('admin model page', () => {
  it('uses a model dropdown beside the test button', () => {
    const wxml = fs.readFileSync(path.join(__dirname, 'models.wxml'), 'utf8');
    assert.equal(wxml.includes('picker'), true);
    assert.equal(wxml.includes('model-caret'), true);
    assert.equal(wxml.includes('item.model'), true);
    assert.equal(wxml.includes('测试'), true);
    assert.equal(wxml.includes('选用'), false);
    assert.equal(wxml.includes('switch'), false);
    assert.equal(wxml.includes('混元'), false);
    const app = fs.readFileSync(path.join(__dirname, '../../../app.json'), 'utf8');
    assert.equal(app.includes('pages/admin/models/models'), true);
  });

  it('saves the picked model and shows whether the call works', async () => {
    const calls = [];
    const events = [];
    global.wx = {
      redirectTo({ url }) {
        events.push(url);
      },
    };
    const page = loadPage(async (data) => {
      calls.push(data);
      if (data.action === 'agentModelConfig') {
        return {
          ok: true,
          models: [
            { id: 'hy3', label: '混元 hy3' },
            { id: 'deepseek-v4.1-flash-1017', label: 'DeepSeek V4.1 Flash' },
          ],
          places: [
            { id: 'video_doc', label: '播放页问答', hint: '讲解页提问时使用', model: 'hy3', modelLabel: '混元 hy3' },
          ],
        };
      }
      if (data.action === 'agentModelTest') {
        return { ok: true, message: '可以调用', text: '好' };
      }
      return {
        ok: true,
        places: [
          {
            id: 'video_doc',
            label: '播放页问答',
            hint: '讲解页提问时使用',
            model: 'deepseek-v4.1-flash-1017',
            modelLabel: 'DeepSeek V4.1 Flash',
          },
        ],
      };
    });

    await page.onShow();
    assert.deepEqual(page.data.modelIds, ['hy3', 'deepseek-v4.1-flash-1017']);
    await page.onPick({
      currentTarget: { dataset: { place: 'video_doc' } },
      detail: { value: '1' },
    });
    assert.deepEqual(calls.map((item) => item.action), ['agentModelConfig', 'agentModelSave']);
    await page.testModel({ currentTarget: { dataset: { place: 'video_doc' } } });

    assert.deepEqual(calls.map((item) => item.action), ['agentModelConfig', 'agentModelSave', 'agentModelTest']);
    assert.equal(calls[1].model, 'deepseek-v4.1-flash-1017');
    assert.equal(calls[2].model, 'deepseek-v4.1-flash-1017');
    assert.equal(page.data.places[0].model, 'deepseek-v4.1-flash-1017');
    assert.equal(page.data.places[0].note, '可以调用：好');
    assert.equal(events.length, 0);
  });
});
