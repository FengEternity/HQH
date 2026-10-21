'use strict';

const fs = require('fs');
const path = require('path');
const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const pagePath = require.resolve('./mine');
const originalPage = global.Page;
const originalWx = global.wx;

function loadPage() {
  delete require.cache[pagePath];
  let definition;
  global.Page = (value) => {
    definition = value;
  };
  global.wx = {};
  require(pagePath);
  return Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(next) {
      this.data = Object.assign({}, this.data, next);
    },
    selectComponent() {
      return null;
    },
  });
}

afterEach(() => {
  delete require.cache[pagePath];
  global.Page = originalPage;
  global.wx = originalWx;
});

describe('mine page', () => {
  it('shows the profile and a quiet version, without a changelog entry', () => {
    const wxml = fs.readFileSync(path.join(__dirname, 'mine.wxml'), 'utf8');
    assert.equal(wxml.includes('关于'), false);
    assert.equal(wxml.includes('openAbout'), false);
    assert.equal(wxml.includes('editProfile'), true);
    assert.equal(wxml.includes('version-foot'), true);
    assert.equal(wxml.includes('profile-gate'), true);
    assert.equal(wxml.includes('prompt="{{false}}"'), true);
    assert.equal(wxml.includes('修改头像与昵称'), false);
    assert.equal(wxml.includes('bindtap="editProfile"'), true);
    const footer = wxml.slice(wxml.indexOf('version-foot'));
    assert.equal(footer.includes('bindtap'), false);
  });

  it('opens the existing profile form with the current name and avatar', () => {
    const page = loadPage();
    const edited = [];
    page.selectComponent = (selector) => {
      assert.equal(selector, '#profileGate');
      return {
        edit(profile) {
          edited.push(profile);
        },
      };
    };
    page.setData({ nickname: '张三', avatarFileId: 'cloud://a' });
    page.editProfile();
    assert.deepEqual(edited, [{ nickname: '张三', avatarFileId: 'cloud://a' }]);
    assert.equal(page.openAbout, undefined);
  });
});
