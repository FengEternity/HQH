'use strict';

const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const apiPath = require.resolve('../../utils/api');
const componentPath = require.resolve('./profile-gate');

function loadComponent(ticketing) {
  delete require.cache[componentPath];
  const api = require(apiPath);
  const originalTicketing = api.ticketing;
  api.ticketing = ticketing;
  const app = { globalData: {} };
  global.getApp = () => app;
  let definition;
  global.Component = (value) => {
    definition = value;
  };
  global.wx = { showToast() {} };
  require(componentPath);
  api.ticketing = originalTicketing;
  const component = Object.assign({}, definition.methods, {
    data: Object.assign({}, definition.data),
    setData(next) {
      this.data = Object.assign({}, this.data, next);
    },
    events: [],
    triggerEvent(name, detail) {
      this.events.push({ name, detail });
    },
  });
  return { component, app };
}

afterEach(() => {
  delete require.cache[componentPath];
});

describe('profile gate', () => {
  it('shows the nickname form on first open and hides it after saving', async () => {
    const calls = [];
    const { component, app } = loadComponent(async (data) => {
      calls.push(data);
      if (data.action === 'csBindProfile') {
        return { ok: true, nickname: data.nickname };
      }
      return { ok: true, nickname: '' };
    });

    await component.load();
    assert.equal(component.data.visible, true);
    assert.deepEqual(calls, [{ action: 'csGetProfile' }]);

    await component.bindProfile({ detail: { value: { nickname: ' 张三 ' } } });
    assert.equal(component.data.visible, false);
    assert.equal(app.globalData.nickname, '张三');
    assert.equal(component.events[0].detail.nickname, '张三');
  });

  it('skips the form when this WeChat already has a nickname', async () => {
    const calls = [];
    const { component } = loadComponent(async (data) => {
      calls.push(data);
      return { ok: true, nickname: '李四' };
    });

    await component.load();
    assert.equal(component.data.visible, false);
    assert.equal(calls[0].action, 'csGetProfile');
    assert.equal(component.events[0].detail.nickname, '李四');
  });

  it('stays closed on 我的 when prompting is turned off', async () => {
    const { component } = loadComponent(async () => ({ ok: true, nickname: '' }));
    component.properties = { prompt: false };
    await component.load();
    assert.equal(component.data.visible, false);
  });

  it('reopens with the saved name so it can be changed', async () => {
    const calls = [];
    const uploads = [];
    const { component, app } = loadComponent(async (data) => {
      calls.push(data);
      return { ok: true, nickname: data.nickname || '李四', avatarFileId: data.avatarFileId || '' };
    });
    global.wx.cloud = {
      uploadFile({ filePath }) {
        uploads.push(filePath);
        return Promise.resolve({ fileID: 'cloud://new' });
      },
    };

    await component.load();
    component.edit({ nickname: '李四', avatarFileId: 'cloud://old' });
    assert.equal(component.data.visible, true);
    assert.equal(component.data.canDismiss, true);
    assert.equal(component.data.nicknameDraft, '李四');
    assert.equal(component.data.avatarUrl, 'cloud://old');

    component.dismiss();
    assert.equal(component.data.visible, false);

    component.edit({ nickname: '李四', avatarFileId: 'cloud://old' });
    await component.bindProfile({ detail: { value: { nickname: '王五' } } });
    assert.deepEqual(uploads, []);
    assert.equal(calls[calls.length - 1].action, 'csBindProfile');
    assert.equal(calls[calls.length - 1].nickname, '王五');
    assert.equal(calls[calls.length - 1].avatarFileId, '');
    assert.equal(app.globalData.nickname, '王五');
    assert.equal(component.data.visible, false);
  });

  it('uploads a newly chosen local avatar when saving an edit', async () => {
    const calls = [];
    const { component } = loadComponent(async (data) => {
      calls.push(data);
      return { ok: true, nickname: data.nickname, avatarFileId: 'cloud://new' };
    });
    global.wx.cloud = {
      uploadFile() {
        return Promise.resolve({ fileID: 'cloud://new' });
      },
    };

    component.edit({ nickname: '李四', avatarFileId: 'cloud://old' });
    component.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp.jpg' } });
    await component.bindProfile({ detail: { value: { nickname: '李四' } } });
    assert.equal(calls[0].avatarFileId, 'cloud://new');
  });

  it('is on the first page and the other places a user can enter', () => {
    const wxml = fs.readFileSync(path.join(__dirname, 'profile-gate.wxml'), 'utf8');
    assert.equal(wxml.includes('type="nickname"'), true);
    assert.equal(wxml.includes('chooseAvatar'), true);
    assert.equal(/line-height:\s*0/.test(wxml), false);
    const wxss = fs.readFileSync(path.join(__dirname, 'profile-gate.wxss'), 'utf8');
    const tipRule = wxss.match(/\.avatar-tip\s*\{([^}]*)\}/);
    assert.ok(tipRule);
    assert.match(tipRule[1], /line-height:\s*28rpx/);
    const placeholderRule = wxss.match(/\.avatar-placeholder\s*\{([^}]*)\}/);
    assert.ok(placeholderRule);
    assert.match(placeholderRule[1], /flex-direction:\s*column/);
    assert.match(placeholderRule[1], /height:\s*100%/);
    for (const page of ['index/index', 'contact/contact', 'mine/mine', 'player/player']) {
      const source = fs.readFileSync(
        path.join(__dirname, '../../pages', page + '.wxml'),
        'utf8',
      );
      assert.equal(source.includes('<profile-gate'), true, page);
    }
  });
});
