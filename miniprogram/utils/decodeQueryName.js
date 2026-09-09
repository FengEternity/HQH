'use strict';

function decodeQueryName(raw) {
  return decodeURIComponent(raw || '');
}

module.exports = { decodeQueryName };
