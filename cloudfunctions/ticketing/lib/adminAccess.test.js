'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ADMIN_CASES = [
  ['csAdminList', 'csAdminList('],
  ['csAdminGet', 'csAdminGet('],
  ['csAdminReply', 'checkText('],
  ['csAdminClose', 'csAdminClose('],
  ['csClaimReply', 'csClaimReply('],
  ['csReleaseReply', 'csReleaseReply('],
  ['csRegisterNotify', 'csRegisterNotify('],
  ['csUnregisterNotify', 'csUnregisterNotify('],
  ['csBindWecom', 'createNotifyBinder('],
  ['csSetNotify', 'createNotifyBinder('],
  ['csNotifyConfig', 'readWecomNotifyStatus('],
];

const PUBLIC_ACTIONS = [
  'csHistory',
  'csSend',
  'csEscalate',
  'csGetProfile',
  'csBindProfile',
];

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

describe('ticketing admin access', () => {
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

  it('awaits staff at each of the 11 admin cases before business work', () => {
    const source = readIndex();
    const main = blockAfter(source, 'exports.main = async (event) =>');
    const dispatch = functionBody(source, 'dispatch');
    const cases = switchCases(dispatch);
    const openidNeedle = "const openid = cloud.getWXContext().OPENID || '';";
    const openidAt = dispatch.indexOf(openidNeedle);
    const names = ADMIN_CASES.map(([name]) => name);

    const sites = ADMIN_CASES.map(([name, businessToken]) => {
      const body = cases[name] || '';
      const authAt = statementIndex(body, STAFF_AWAIT);
      const businessAt = body.indexOf(businessToken);
      return {
        name,
        authLines: requireAdminLines(body),
        awaitsStaffBeforeBusiness: authAt >= 0 && businessAt > authAt,
        eventTicket: countNeedle(body, 'event.ticket'),
      };
    });

    assert.equal(ADMIN_CASES.length, 11);
    assert.deepEqual(Object.keys(cases).sort(), [...PUBLIC_ACTIONS, ...names].sort());
    assert.deepEqual(
      {
        openidBindings: countNeedle(source, 'cloud.getWXContext().OPENID'),
        openidBeforeSwitch: openidAt >= 0 && openidAt < dispatch.indexOf('switch'),
        eventOpenid: countNeedle(source, 'event.openid'),
        exactAdminAwaits: countNeedle(source, 'await requireAdmin(db, openid)'),
        syncTicketCalls: countNeedle(source, 'requireAdmin(event.ticket)'),
        wiredSiteCount: sites.filter((site) => site.awaitsStaffBeforeBusiness).length,
        sites,
        publicActions: PUBLIC_ACTIONS.map((name) => ({
          name,
          authLines: requireAdminLines(cases[name] || ''),
        })),
        wecomBeforeDispatch:
          main.indexOf('handleWecomCallback') >= 0 &&
          main.indexOf('handleWecomCallback') < main.indexOf('dispatch('),
        keepsErrorWrapper:
          main.includes("code: error.code || 'FAIL'") &&
          main.includes("message: error.message || 'FAIL'"),
      },
      {
        openidBindings: 1,
        openidBeforeSwitch: true,
        eventOpenid: 0,
        exactAdminAwaits: ADMIN_CASES.length,
        syncTicketCalls: 0,
        wiredSiteCount: ADMIN_CASES.length,
        sites: names.map((name) => ({
          name,
          authLines: [STAFF_AWAIT],
          awaitsStaffBeforeBusiness: true,
          eventTicket: 0,
        })),
        publicActions: PUBLIC_ACTIONS.map((name) => ({ name, authLines: [] })),
        wecomBeforeDispatch: true,
        keepsErrorWrapper: true,
      },
    );
  });
});
