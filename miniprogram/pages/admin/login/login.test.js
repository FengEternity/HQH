'use strict';

const { afterEach, it } = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../../../utils/api');
const configPath = require.resolve('../../../config.js');
const pagePath = require.resolve('./login');
const originalPage = global.Page;
const originalWx = global.wx;

function loadPage({ templateId, catalog, ticketingAdmin }) {
  delete require.cache[pagePath];
  const api = require(apiPath);
  const originals = {
    catalog: api.catalog,
    ticketingAdmin: api.ticketingAdmin,
    setTicket: api.setTicket,
  };
  const tickets = [];
  api.catalog = catalog;
  api.ticketingAdmin = ticketingAdmin;
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

it('logs in without requesting or registering notifications', async () => {
  const events = [];
  global.wx = {
    requestSubscribeMessage() {
      events.push(['subscribe']);
      return Promise.resolve({ 'new-ticket-template': 'accept' });
    },
    redirectTo({ url }) {
      events.push(['redirect', url]);
    },
    showToast() {},
  };
  const { page, tickets } = loadPage({
    templateId: 'new-ticket-template',
    catalog: async () => ({ ok: true, ticket: 'ticket-1' }),
    ticketingAdmin: async (data) => {
      events.push(['register', data.action]);
      return { ok: true };
    },
  });
  page.data.pin = '1234';

  await page.onLogin();

  assert.deepEqual(tickets, ['ticket-1']);
  assert.deepEqual(events, [['redirect', '/pages/admin/home/home']]);
});

it('redirects after notification registration fails without showing login failure', async () => {
  const events = [];
  global.wx = {
    redirectTo({ url }) {
      events.push(['redirect', url]);
    },
    showToast({ title }) {
      events.push(['toast', title]);
    },
  };
  const { page, tickets } = loadPage({
    templateId: '',
    catalog: async () => ({ ok: true, ticket: 'ticket-2' }),
    ticketingAdmin: async () => {
      throw new Error('register failed');
    },
  });
  page.data.pin = '5678';

  await page.onLogin();

  assert.deepEqual(tickets, ['ticket-2']);
  assert.deepEqual(events, [
    ['redirect', '/pages/admin/home/home'],
  ]);
});
