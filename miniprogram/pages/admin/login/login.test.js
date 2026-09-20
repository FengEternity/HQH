'use strict';

const { afterEach, it } = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../../../utils/api');
const configPath = require.resolve('../../../config.js');
const pagePath = require.resolve('./login');
const originalPage = global.Page;
const originalWx = global.wx;

function loadPage({ templateId, catalog, csAdmin }) {
  delete require.cache[pagePath];
  const api = require(apiPath);
  const originals = {
    catalog: api.catalog,
    csAdmin: api.csAdmin,
    setTicket: api.setTicket,
  };
  const tickets = [];
  api.catalog = catalog;
  api.csAdmin = csAdmin;
  api.setTicket = (ticket) => tickets.push(ticket);

  const config = require(configPath);
  config.contact.newTicketTplId = templateId;

  let definition;
  global.Page = (value) => {
    definition = value;
  };
  require(pagePath);

  Object.assign(api, originals);
  return {
    page: Object.assign({}, definition, {
      data: Object.assign({}, definition.data),
      setData(next) {
        this.data = Object.assign({}, this.data, next);
      },
    }),
    tickets,
  };
}

afterEach(() => {
  delete require.cache[pagePath];
  global.Page = originalPage;
  global.wx = originalWx;
});

it('registers admin notifications after denied subscription, then redirects', async () => {
  const events = [];
  global.wx = {
    requestSubscribeMessage({ tmplIds }) {
      events.push(['subscribe', tmplIds]);
      return Promise.reject(new Error('denied'));
    },
    redirectTo({ url }) {
      events.push(['redirect', url]);
    },
    showToast() {},
  };
  const { page, tickets } = loadPage({
    templateId: 'new-ticket-template',
    catalog: async () => ({ ok: true, ticket: 'ticket-1' }),
    csAdmin: async (data) => {
      events.push(['register', data]);
      return { ok: true };
    },
  });
  page.data.pin = '1234';

  await page.onLogin();

  assert.deepEqual(tickets, ['ticket-1']);
  assert.deepEqual(events, [
    ['subscribe', ['new-ticket-template']],
    ['register', { action: 'csRegisterNotify' }],
    ['redirect', '/pages/admin/home/home'],
  ]);
});
