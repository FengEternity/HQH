'use strict';

const { requireStaff } = require('./adminStaff');
const { verifyTicket } = require('./ticket');

const SERVICE_ACTIONS = Object.freeze([
  'adminListBrands',
  'adminListVideos',
  'claimVideoIngest',
  'completeVideoIngest',
  'noteVideoIntro',
  'replacePlaybackMedia',
  'upsertBrand',
  'upsertVideo',
]);

function unauthorized() {
  const error = new Error('UNAUTHORIZED');
  error.code = 'UNAUTHORIZED';
  return error;
}

async function requireCatalogAccess({ db, openid, action, ticket, pin }) {
  if (openid) {
    return await requireStaff(db, openid);
  }
  if (!SERVICE_ACTIONS.includes(action) || !verifyTicket(pin, ticket)) {
    throw unauthorized();
  }
}

module.exports = {
  SERVICE_ACTIONS,
  requireCatalogAccess,
};
