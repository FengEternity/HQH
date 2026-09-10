'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  envLabel,
  normalizeDoc,
  visibleReleases,
  wxVersionLine,
  clipboardText,
  isStaffMode,
  buildAboutView,
} = require('./appRelease');

describe('release data module', () => {
  it('ships as a js module, since wx require cannot load .json', () => {
    const doc = normalizeDoc(require('../data/appRelease'));
    assert.notEqual(doc.version, '未知');
    assert.ok(doc.releases.length > 0);
  });

  it('stays on 0.x until official WeChat release', () => {
    const doc = require('../data/appRelease');
    assert.match(String(doc.version), /^0\.\d+\.\d+$/);
  });

  it('is never required as .json anywhere under miniprogram', () => {
    const root = path.join(__dirname, '..');
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.js')) {
          if (/require\([^)]*\.json['"]\)/.test(fs.readFileSync(full, 'utf8'))) {
            offenders.push(path.relative(root, full));
          }
        }
      }
    };
    walk(root);
    assert.deepEqual(offenders, []);
  });
});

describe('envLabel', () => {
  it('maps WeChat envVersion to Chinese labels', () => {
    assert.equal(envLabel('develop'), '开发版');
    assert.equal(envLabel('trial'), '体验版');
    assert.equal(envLabel('release'), '正式版');
    assert.equal(envLabel(''), '未知环境');
    assert.equal(envLabel(undefined), '未知环境');
  });
});

describe('normalizeDoc', () => {
  it('treats missing or invalid payload as unknown version and empty list', () => {
    assert.deepEqual(normalizeDoc(null), { version: '未知', releases: [] });
    assert.deepEqual(normalizeDoc('x'), { version: '未知', releases: [] });
    assert.deepEqual(normalizeDoc({ version: 1, releases: 'nope' }), {
      version: '未知',
      releases: [],
    });
  });

  it('keeps string version and normalizes note arrays', () => {
    const out = normalizeDoc({
      version: '0.1.0',
      releases: [
        { version: '0.1.0', date: '2026-09-09', user: ['可见'], internal: ['内部'] },
        { version: '0.0.9', date: '2026-09-01' },
      ],
    });
    assert.equal(out.version, '0.1.0');
    assert.equal(out.releases.length, 2);
    assert.deepEqual(out.releases[0].user, ['可见']);
    assert.deepEqual(out.releases[1].internal, []);
  });
});

describe('visibleReleases', () => {
  const releases = [
    { version: '2', date: '2026-09-09', user: ['用户可见'], internal: ['内部'] },
    { version: '1', date: '2026-09-01', user: [], internal: ['仅热修'] },
  ];

  it('hides internal-only versions on the user path', () => {
    const out = visibleReleases(releases, false);
    assert.equal(out.length, 1);
    assert.equal(out[0].version, '2');
    assert.deepEqual(out[0].internal, []);
  });

  it('keeps internal notes on the staff path', () => {
    const out = visibleReleases(releases, true);
    assert.equal(out.length, 2);
    assert.deepEqual(out[1].internal, ['仅热修']);
  });
});

describe('wxVersionLine', () => {
  it('is empty on the user path', () => {
    assert.equal(wxVersionLine(false, '1.0.0'), '');
  });

  it('shows WeChat version or fallback on staff path', () => {
    assert.equal(wxVersionLine(true, '1.2.3'), '微信版本 1.2.3');
    assert.equal(wxVersionLine(true, ''), '微信后台版本号仅正式版可见');
  });
});

describe('clipboardText', () => {
  it('copies package version and env; staff appends WeChat version when present', () => {
    assert.equal(
      clipboardText({ version: '0.1.0', envLabel: '开发版', staff: false, wxVersion: '' }),
      '优度 0.1.0 · 开发版',
    );
    assert.equal(
      clipboardText({
        version: '0.1.0',
        envLabel: '正式版',
        staff: true,
        wxVersion: '1.0.0',
      }),
      '优度 0.1.0 · 正式版 · 微信 1.0.0',
    );
  });
});

describe('isStaffMode', () => {
  it('is true only for staff=1', () => {
    assert.equal(isStaffMode({ staff: '1' }), true);
    assert.equal(isStaffMode({ staff: 'true' }), false);
    assert.equal(isStaffMode({}), false);
  });
});

describe('buildAboutView', () => {
  const doc = {
    version: '0.1.0',
    releases: [
      { version: '0.1.0', date: '2026-09-09', user: ['可看版本'], internal: ['关于页'] },
    ],
  };

  it('builds user view without WeChat row or internal notes', () => {
    const view = buildAboutView({
      doc,
      accountInfo: { miniProgram: { envVersion: 'develop', version: '' } },
      staff: false,
    });
    assert.equal(view.productName, '优度 · 仪器讲解');
    assert.equal(view.version, '0.1.0');
    assert.equal(view.envLabel, '开发版');
    assert.equal(view.showWxRow, false);
    assert.equal(view.emptyHint, '');
    assert.deepEqual(view.releases[0].internal, []);
  });

  it('shows empty hint when user path has no public notes', () => {
    const view = buildAboutView({
      doc: { version: '0.1.0', releases: [{ version: '0.1.0', user: [], internal: ['x'] }] },
      accountInfo: { miniProgram: { envVersion: 'trial' } },
      staff: false,
    });
    assert.equal(view.emptyHint, '暂无面向用户的更新说明');
    assert.equal(view.releases.length, 0);
  });
});
