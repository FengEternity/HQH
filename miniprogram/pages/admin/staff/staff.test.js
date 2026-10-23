'use strict';

const fs = require('fs');
const path = require('path');
const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../../../utils/api');
const pagePath = require.resolve('./staff');
const originalPage = global.Page;
const originalWx = global.wx;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function loadPage(admin) {
  delete require.cache[pagePath];
  const api = require(apiPath);
  const original = api.admin;
  api.admin = admin;

  let definition;
  global.Page = (value) => {
    definition = value;
  };
  require(pagePath);
  api.admin = original;

  return Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(next) {
      this.data = Object.assign({}, this.data, next);
    },
  });
}

function wxStub(events, actionTaps = [], modalConfirms = []) {
  return {
    env: { USER_DATA_PATH: '/tmp/user-data' },
    showToast({ title }) {
      events.push(['toast', title]);
    },
    navigateBack() {
      events.push(['back']);
    },
    switchTab({ url }) {
      events.push(['switchTab', url]);
    },
    showActionSheet({ itemList, success, fail }) {
      events.push(['sheet', itemList]);
      const tapIndex = actionTaps.shift();
      if (tapIndex === undefined) {
        if (fail) fail({ errMsg: 'showActionSheet:fail cancel' });
        return;
      }
      success({ tapIndex });
    },
    showModal({ success }) {
      events.push(['modal']);
      success({ confirm: modalConfirms.shift() === true });
    },
    getFileSystemManager() {
      return {
        writeFile(options) {
          events.push(['write', options.filePath, options.data, options.encoding]);
          options.success();
        },
      };
    },
    createSelectorQuery() {
      const canvas = {
        getContext() {
          return {
            scale() {},
            fillRect() {},
            drawImage() {},
            fillText(text, x, y) {
              events.push(['fillText', text, x, y]);
            },
          };
        },
        createImage() {
          const image = {};
          Object.defineProperty(image, 'src', {
            set() {
              if (typeof image.onload === 'function') image.onload();
            },
          });
          return image;
        },
      };
      const query = {
        in() {
          return query;
        },
        select() {
          return query;
        },
        fields() {
          return query;
        },
        exec(callback) {
          callback([{ node: canvas }]);
        },
      };
      return query;
    },
    getWindowInfo() {
      return { pixelRatio: 1 };
    },
    canvasToTempFilePath({ success }) {
      success({ tempFilePath: '/tmp/user-data/admin-invite-card.png' });
    },
    saveImageToPhotosAlbum({ filePath, success }) {
      events.push(['save', filePath]);
      success();
    },
  };
}

afterEach(() => {
  delete require.cache[pagePath];
  global.Page = originalPage;
  global.wx = originalWx;
});

describe('admin staff page', () => {
  it('loads labeled staff without rendering OpenID text or self controls', async () => {
    const wxml = fs.readFileSync(path.join(__dirname, 'staff.wxml'), 'utf8');
    assert.equal(/openid|OpenID/i.test(wxml), false);
    assert.equal(wxml.includes('data-id="{{item.id}}"'), true);
    const visibleWxml = wxml.replace('data-id="{{item.id}}"', '');
    assert.equal(/item\.(?:id|openid)/i.test(visibleWxml), false);
    assert.equal(wxml.includes('wx:if="{{!item.isSelf}}"'), true);

    global.wx = wxStub([]);
    const page = loadPage(async () => ({
      ok: true,
      staff: [
        {
          id: 'openid-self',
          nickname: '',
          role: 'admin',
          enabled: true,
          isSelf: true,
        },
        {
          id: 'openid-other',
          nickname: '小王',
          role: 'operator',
          enabled: false,
          isSelf: false,
        },
      ],
    }));

    await page.onShow();

    assert.deepEqual(
      page.data.staff.map(({ name, roleLabel, statusLabel, isSelf }) => ({
        name,
        roleLabel,
        statusLabel,
        isSelf,
      })),
      [
        { name: '未设置昵称', roleLabel: '管理员', statusLabel: '启用', isSelf: true },
        { name: '小王', roleLabel: '运营', statusLabel: '已停用', isSelf: false },
      ],
    );
  });

  it('updates another person role and confirms before disabling', async () => {
    const calls = [];
    const events = [];
    global.wx = wxStub(events, [0, 1], [true]);
    const page = loadPage(async (data) => {
      calls.push(data);
      if (data.action === 'adminListStaff') {
        return {
          ok: true,
          staff: [
            { id: 'other', nickname: '小王', role: 'operator', enabled: true, isSelf: false },
          ],
        };
      }
      return { ok: true, role: data.role, enabled: data.enabled };
    });
    await page.onShow();

    await page.openActions({ currentTarget: { dataset: { id: 'other' } } });
    await page.openActions({ currentTarget: { dataset: { id: 'other' } } });

    assert.deepEqual(
      calls.filter((item) => item.action === 'adminUpdateStaff'),
      [
        { action: 'adminUpdateStaff', id: 'other', role: 'admin', enabled: true },
        { action: 'adminUpdateStaff', id: 'other', role: 'admin', enabled: false },
      ],
    );
    assert.equal(events.filter((item) => item[0] === 'modal').length, 1);
  });

  it('reorders the visible list after a role or enabled update', async () => {
    const events = [];
    global.wx = wxStub(events, [0, 1], [true]);
    const page = loadPage(async (data) => {
      if (data.action === 'adminListStaff') {
        return {
          ok: true,
          staff: [
            {
              id: 'admin-late',
              nickname: '后加入管理员',
              role: 'admin',
              enabled: true,
              createdAt: 30,
              isSelf: false,
            },
            {
              id: 'operator-early',
              nickname: '早加入运营',
              role: 'operator',
              enabled: true,
              createdAt: 10,
              isSelf: false,
            },
            {
              id: 'operator-late',
              nickname: '后加入运营',
              role: 'operator',
              enabled: true,
              createdAt: 20,
              isSelf: false,
            },
          ],
        };
      }
      return { ok: true, role: data.role, enabled: data.enabled };
    });
    await page.onShow();

    await page.openActions({ currentTarget: { dataset: { id: 'operator-late' } } });
    assert.deepEqual(
      page.data.staff.map((item) => item.id),
      ['operator-late', 'admin-late', 'operator-early'],
    );

    await page.openActions({ currentTarget: { dataset: { id: 'operator-late' } } });
    assert.deepEqual(
      page.data.staff.map((item) => item.id),
      ['admin-late', 'operator-early', 'operator-late'],
    );
  });

  it('blocks a second staff update while the first action is pending', async () => {
    const update = deferred();
    const calls = [];
    global.wx = wxStub([], [0, 0]);
    const page = loadPage(async (data) => {
      if (data.action === 'adminListStaff') {
        return {
          ok: true,
          staff: [
            { id: 'other', nickname: '小王', role: 'operator', enabled: true, isSelf: false },
          ],
        };
      }
      calls.push(data);
      return update.promise;
    });
    await page.onShow();

    const first = page.openActions({ currentTarget: { dataset: { id: 'other' } } });
    const second = page.openActions({ currentTarget: { dataset: { id: 'other' } } });
    await Promise.resolve();

    assert.equal(calls.length, 1);
    update.resolve({ ok: true, role: 'admin', enabled: true });
    await Promise.all([first, second]);
  });

  it('releases the staff action lock after failure so a retry can run', async () => {
    let updateCount = 0;
    global.wx = wxStub([], [0, 0]);
    const page = loadPage(async (data) => {
      if (data.action === 'adminListStaff') {
        return {
          ok: true,
          staff: [
            { id: 'other', nickname: '小王', role: 'operator', enabled: true, isSelf: false },
          ],
        };
      }
      updateCount += 1;
      if (updateCount === 1) throw new Error('update failed');
      return { ok: true, role: data.role, enabled: data.enabled };
    });
    await page.onShow();

    await page.openActions({ currentTarget: { dataset: { id: 'other' } } });
    await page.openActions({ currentTarget: { dataset: { id: 'other' } } });

    assert.equal(updateCount, 2);
  });

  it('does not open controls for the self row', async () => {
    const events = [];
    global.wx = wxStub(events);
    const page = loadPage(async () => ({
      ok: true,
      staff: [
        { id: 'self', nickname: '我', role: 'admin', enabled: true, isSelf: true },
      ],
    }));
    await page.onShow();

    await page.openActions({ currentTarget: { dataset: { id: 'self' } } });

    assert.equal(events.some((item) => item[0] === 'sheet'), false);
  });

  it('creates an operator invite by default and saves its QR image', async () => {
    const calls = [];
    const events = [];
    global.wx = wxStub(events, [0]);
    const page = loadPage(async (data) => {
      calls.push(data);
      if (data.action === 'adminListStaff') return { ok: true, staff: [] };
      return {
        ok: true,
        generated: true,
        expiresAt: Date.parse('2026-10-24T03:17:00.000Z'),
        imageBase64: 'base64-image',
        contentType: 'image/jpeg',
        message: '',
      };
    });

    await page.createInvite();

    assert.deepEqual(calls, [{ action: 'adminCreateInvite', role: 'operator' }]);
    assert.deepEqual(
      events.filter((item) => item[0] === 'fillText').map((item) => item[1]),
      ['2026-10-24 11:17', '24 小时有效'],
    );
    assert.ok(
      events.filter((item) => item[0] === 'fillText').every((item) => item[3] > 360),
    );
    assert.deepEqual(
      events.filter((item) => item[0] === 'write' || item[0] === 'save'),
      [
        ['write', '/tmp/user-data/admin-invite-qr.jpg', 'base64-image', 'base64'],
        ['save', '/tmp/user-data/admin-invite-card.png'],
      ],
    );
  });

  it('creates an admin invite when the administrator role is selected', async () => {
    const calls = [];
    global.wx = wxStub([], [1]);
    const page = loadPage(async (data) => {
      calls.push(data);
      return { ok: true, generated: false };
    });

    await page.createInvite();

    assert.deepEqual(calls, [{ action: 'adminCreateInvite', role: 'admin' }]);
  });

  it('does not create on cancel and releases the invite lock for retry', async () => {
    const calls = [];
    global.wx = wxStub([], [undefined, 0]);
    const page = loadPage(async (data) => {
      calls.push(data);
      return { ok: true, generated: false };
    });

    await page.createInvite();
    assert.deepEqual(calls, []);

    await page.createInvite();
    assert.deepEqual(calls, [{ action: 'adminCreateInvite', role: 'operator' }]);
  });

  it('blocks a second invite while creation and saving are pending', async () => {
    const creation = deferred();
    let createCount = 0;
    global.wx = wxStub([], [0, 0]);
    const page = loadPage(async () => {
      createCount += 1;
      return creation.promise;
    });

    const first = page.createInvite();
    const second = page.createInvite();
    await Promise.resolve();

    assert.equal(createCount, 1);
    creation.resolve({ ok: true, generated: false });
    await Promise.all([first, second]);
  });

  it('keeps the invite lock until the generated image finishes saving', async () => {
    let finishSave;
    let createCount = 0;
    const wx = wxStub([], [0, 0]);
    wx.saveImageToPhotosAlbum = ({ success }) => {
      finishSave = success;
    };
    global.wx = wx;
    const page = loadPage(async () => {
      createCount += 1;
      return {
        ok: true,
        generated: true,
        expiresAt: Date.parse('2026-10-24T03:17:00.000Z'),
        imageBase64: 'image',
      };
    });

    const first = page.createInvite();
    await new Promise((resolve) => setImmediate(resolve));
    const second = page.createInvite();

    assert.equal(createCount, 1);
    assert.equal(typeof finishSave, 'function');
    finishSave();
    await Promise.all([first, second]);
  });

  it('releases the invite lock after failure so a retry can run', async () => {
    let createCount = 0;
    global.wx = wxStub([], [0, 0]);
    const page = loadPage(async () => {
      createCount += 1;
      if (createCount === 1) throw new Error('create failed');
      return { ok: true, generated: false };
    });

    await page.createInvite();
    await page.createInvite();

    assert.equal(createCount, 2);
  });

  it('keeps the invite and explains when no QR image was generated', async () => {
    const events = [];
    global.wx = wxStub(events, [0]);
    const page = loadPage(async () => ({
      ok: true,
      generated: false,
      imageBase64: '',
      contentType: '',
      message: '发布后才能生成小程序码',
    }));

    await page.createInvite();

    assert.deepEqual(events.filter((item) => item[0] === 'toast'), [
      ['toast', '发布后才能生成小程序码'],
    ]);
    assert.equal(events.some((item) => item[0] === 'write'), false);
  });

  it('reports a save failure without trying to recreate the invite', async () => {
    const events = [];
    const wx = wxStub(events, [0]);
    wx.saveImageToPhotosAlbum = ({ fail }) => fail(new Error('denied'));
    global.wx = wx;
    let createCount = 0;
    const page = loadPage(async (data) => {
      if (data.action === 'adminCreateInvite') createCount += 1;
      return {
        ok: true,
        generated: true,
        expiresAt: Date.parse('2026-10-24T03:17:00.000Z'),
        imageBase64: 'image',
      };
    });

    await page.createInvite();

    assert.equal(createCount, 1);
    assert.deepEqual(events.filter((item) => item[0] === 'toast'), [
      ['toast', '保存失败'],
    ]);
  });

  it('handles staff domain and access errors with exact navigation', async () => {
    const cases = [
      {
        code: 'LAST_ADMIN',
        title: '至少保留一名管理员',
        expectedNavigation: [],
      },
      {
        code: 'CANNOT_EDIT_SELF',
        title: '不能修改自己',
        expectedNavigation: [],
      },
      {
        code: 'FORBIDDEN',
        title: '只有管理员能修改人员',
        expectedNavigation: [['back']],
      },
      {
        code: 'UNAUTHORIZED',
        title: null,
        expectedNavigation: [['switchTab', '/pages/mine/mine']],
      },
    ];

    for (const item of cases) {
      const events = [];
      global.wx = wxStub(events);
      const page = loadPage(async () => {
        const error = new Error('server text');
        error.code = item.code;
        throw error;
      });

      await page.onShow();

      assert.deepEqual(
        events.filter((event) => event[0] === 'back' || event[0] === 'switchTab'),
        item.expectedNavigation,
        item.code,
      );
      assert.deepEqual(
        events.filter((event) => event[0] === 'toast').map((event) => event[1]),
        item.title ? [item.title] : [],
        item.code,
      );
    }
  });
});
