'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ADMIN_FUNCTIONS = [
  'upsertShopProduct',
  'setShopProductStatus',
  'setVideoShopLinks',
  'listShopAdmin',
];

const PUBLIC_FUNCTIONS = [
  'listPublishedShop',
  'getPublishedShop',
  'listLinkedShopProducts',
  'listLinkedVideos',
];

const PUBLIC_ACTIONS = ['ping', ...PUBLIC_FUNCTIONS];
const STAFF_AWAIT = 'await requireAdmin(db, openid);';

function readIndex() {
  return fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
}

function blockAfter(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
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
  assert.fail(`unterminated ${signature}`);
}

function functionBody(source, name) {
  return blockAfter(source, `async function ${name}(`);
}

function switchCases(fnBody) {
  const cases = {};
  const matches = [...fnBody.matchAll(/case '([^']+)':/g)];
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index].index + matches[index][0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : fnBody.indexOf('default:');
    assert.notEqual(end, -1, `missing end for ${matches[index][1]}`);
    cases[matches[index][1]] = fnBody.slice(start, end);
  }
  return cases;
}

function significantLines(body) {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'));
}

function requireAdminLines(body) {
  return significantLines(body).filter((line) => line.includes('requireAdmin('));
}

function countNeedle(source, needle) {
  let count = 0;
  let from = 0;
  while (from < source.length) {
    const at = source.indexOf(needle, from);
    if (at === -1) {
      return count;
    }
    count += 1;
    from = at + needle.length;
  }
  return count;
}

function statementIndex(body, statement) {
  const lines = body.split('\n');
  let offset = 0;
  for (const line of lines) {
    if (line.trim() === statement) {
      return offset + line.indexOf(statement);
    }
    offset += line.length + 1;
  }
  return -1;
}

describe('shop admin access', () => {
  it('delegates requireAdmin to requireStaff and drops ticket authorization', () => {
    const source = readIndex();
    const signature = 'async function requireAdmin(db, openid)';
    const body = source.includes(signature) ? functionBody(source, 'requireAdmin') : '';

    assert.deepEqual(
      {
        importsStaff: source.includes("const { requireStaff } = require('./lib/adminStaff');"),
        staffStatements: significantLines(body),
        verifyTicket: countNeedle(source, 'verifyTicket'),
        adminPin: countNeedle(source, 'ADMIN_PIN'),
        eventTicket: countNeedle(source, 'event.ticket'),
        ticketModule: countNeedle(source, './lib/ticket'),
      },
      {
        importsStaff: true,
        staffStatements: ['await requireStaff(db, openid);'],
        verifyTicket: 0,
        adminPin: 0,
        eventTicket: 0,
        ticketModule: 0,
      },
    );
  });

  it('checks staff at each admin function before reads and leaves public actions open', () => {
    const source = readIndex();
    const main = blockAfter(source, 'exports.main = async (event) =>');
    const dispatch = functionBody(source, 'dispatch');
    const cases = switchCases(dispatch);
    const openidNeedle = "const openid = cloud.getWXContext().OPENID || '';";
    const openidAt = main.indexOf(openidNeedle);

    const sites = ADMIN_FUNCTIONS.map((name) => {
      const body = functionBody(source, name);
      const signature = source.match(new RegExp(`async function ${name}\\(([^)]*)\\)`));
      const authAt = statementIndex(body, STAFF_AWAIT);
      const readAt = body.indexOf('db.collection');
      return {
        name,
        parameters: signature ? signature[1] : '',
        authLines: requireAdminLines(body),
        awaitsStaffBeforeRead: authAt >= 0 && readAt > authAt,
        caseLines: significantLines(cases[name] || ''),
      };
    });

    assert.equal(ADMIN_FUNCTIONS.length, 4);
    assert.deepEqual(Object.keys(cases).sort(), [...PUBLIC_ACTIONS, ...ADMIN_FUNCTIONS].sort());
    assert.deepEqual(
      {
        openidBindings: countNeedle(source, 'cloud.getWXContext().OPENID'),
        openidBeforeDispatch: openidAt >= 0 && openidAt < main.indexOf('dispatch('),
        dispatchPassesOpenid: countNeedle(main, 'dispatch(event, openid)'),
        eventOpenid: countNeedle(source, 'event.openid'),
        exactAdminAwaits: countNeedle(source, 'await requireAdmin(db, openid)'),
        ticketAdminCalls: countNeedle(source, 'requireAdmin(event.ticket)'),
        wiredSiteCount: sites.filter((site) => site.awaitsStaffBeforeRead).length,
        sites,
        publicFunctions: PUBLIC_FUNCTIONS.map((name) => ({
          name,
          authLines: requireAdminLines(functionBody(source, name)),
        })),
        publicActions: PUBLIC_ACTIONS.map((name) => ({
          name,
          authLines: requireAdminLines(cases[name] || ''),
        })),
        keepsErrorWrapper:
          main.includes("code: error.code || 'FAIL'") &&
          main.includes("message: error.message || 'FAIL'"),
      },
      {
        openidBindings: 1,
        openidBeforeDispatch: true,
        dispatchPassesOpenid: 2,
        eventOpenid: 0,
        exactAdminAwaits: ADMIN_FUNCTIONS.length,
        ticketAdminCalls: 0,
        wiredSiteCount: ADMIN_FUNCTIONS.length,
        sites: ADMIN_FUNCTIONS.map((name) => ({
          name,
          parameters: 'event, openid',
          authLines: [STAFF_AWAIT],
          awaitsStaffBeforeRead: true,
          caseLines: [`return await ${name}(event, openid);`],
        })),
        publicFunctions: PUBLIC_FUNCTIONS.map((name) => ({ name, authLines: [] })),
        publicActions: PUBLIC_ACTIONS.map((name) => ({ name, authLines: [] })),
        keepsErrorWrapper: true,
      },
    );
  });
});
