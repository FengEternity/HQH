'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { issueTicket } = require('./ticket');
const {
  SERVICE_ACTIONS,
  requireCatalogAccess,
} = require('./adminAccess');

function createDb(records = {}) {
  return {
    collection(name) {
      assert.equal(name, 'admin_users');
      return {
        doc(id) {
          return {
            async get() {
              return { data: records[id] || null };
            },
          };
        },
      };
    },
  };
}

function assertCode(code) {
  return (error) => {
    assert.equal(error.code, code);
    return true;
  };
}

function functionBody(source, name) {
  const signature = `async function ${name}(`;
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${name}`);
  const openingBrace = source.indexOf('{', start);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
    } else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openingBrace + 1, index);
      }
    }
  }
  assert.fail(`unterminated ${name}`);
}

describe('adminAccess', () => {
  it('exposes exactly the service action allowlist', () => {
    assert.deepEqual([...SERVICE_ACTIONS], [
      'adminListBrands',
      'adminListVideos',
      'claimVideoIngest',
      'completeVideoIngest',
      'noteVideoIntro',
      'replacePlaybackMedia',
      'upsertBrand',
      'upsertVideo',
    ]);
  });

  it('uses staff membership whenever openid is present', async () => {
    const db = createDb({
      staff: { openid: 'staff', role: 'operator', enabled: true },
    });

    const result = await requireCatalogAccess({
      db,
      openid: 'staff',
      action: 'deleteVideo',
      ticket: '',
      pin: 'secret',
    });

    assert.equal(result.openid, 'staff');
  });

  it('does not let a ticket bypass membership for a WeChat caller', async () => {
    const pin = 'secret';

    await assert.rejects(
      requireCatalogAccess({
        db: createDb(),
        openid: 'ordinary-user',
        action: 'upsertVideo',
        ticket: issueTicket(pin, 60_000),
        pin,
      }),
      assertCode('UNAUTHORIZED'),
    );
  });

  it('allows a valid service ticket only for an allowlisted action without openid', async () => {
    const pin = 'secret';

    const result = await requireCatalogAccess({
      db: createDb(),
      openid: '',
      action: 'claimVideoIngest',
      ticket: issueTicket(pin, 60_000),
      pin,
    });

    assert.equal(result, undefined);
  });

  it('rejects non-allowlisted service actions', async () => {
    const pin = 'secret';

    await assert.rejects(
      requireCatalogAccess({
        db: createDb(),
        openid: '',
        action: 'deleteVideo',
        ticket: issueTicket(pin, 60_000),
        pin,
      }),
      assertCode('UNAUTHORIZED'),
    );
  });

  it('rejects service access with no ticket', async () => {
    await assert.rejects(
      requireCatalogAccess({
        db: createDb(),
        openid: '',
        action: 'upsertVideo',
        ticket: '',
        pin: 'secret',
      }),
      assertCode('UNAUTHORIZED'),
    );
  });

  it('wires every existing management action through catalog access', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const actions = [
      'adminListBrands',
      'adminListVideos',
      'adminGetVideo',
      'upsertBrand',
      'deleteBrand',
      'upsertProduct',
      'upsertSynonym',
      'upsertVideo',
      'enqueueVideoIngest',
      'enqueueNoncompliantVideos',
      'getIngestProgress',
      'replacePlaybackMedia',
      'claimVideoIngest',
      'noteVideoIntro',
      'completeVideoIngest',
      'publishVideo',
      'unpublishVideo',
      'deleteVideo',
      'adminListSupport',
      'adminReadSupport',
    ];

    for (const action of actions) {
      const body = functionBody(source, action);
      assert.match(body, /await requireCatalogAccess\(\{/);
      assert.match(body, /\bopenid,/);
      assert.match(body, /action: event\.action/);
    }
    assert.doesNotMatch(source, /function requireAdmin|requireAdmin\(event\.ticket\)/);
  });

  it('wires WeChat identity and all staff actions', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

    assert.match(source, /const openid = cloud\.getWXContext\(\)\.OPENID \|\| '';/);
    for (const action of [
      'adminMe',
      'adminListStaff',
      'adminUpdateStaff',
      'adminCreateInvite',
      'adminClaimInvite',
    ]) {
      assert.match(source, new RegExp(`case '${action}':`));
      assert.match(source, new RegExp(`async function ${action}\\(`));
    }
    assert.match(functionBody(source, 'adminMe'), /getAdminState\(db, openid\)/);
    assert.doesNotMatch(functionBody(source, 'adminMe'), /requireCatalogAccess/);
    assert.match(functionBody(source, 'adminLogin'), /bootstrapAdmin\(db,/);
    assert.match(functionBody(source, 'adminLogin'), /issueTicket\(/);
  });

  it('persists invites before QR generation and keeps QR failures nonfatal', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const body = functionBody(source, 'adminCreateInvite');

    assert.ok(body.indexOf('createInvite(db,') < body.indexOf('cloud.openapi.wxacode.get('));
    assert.match(body, /result\.buffer/);
    assert.match(body, /toString\('base64'\)/);
    assert.match(body, /generated: false/);
    assert.match(body, /发布后才能生成小程序码/);
    assert.doesNotMatch(body, /\.remove\(/);
  });

  it('declares wxacode permission without dropping content security', () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'),
    );

    assert.deepEqual(config.permissions.openapi, [
      'security.msgSecCheck',
      'wxacode.get',
    ]);
  });
});
