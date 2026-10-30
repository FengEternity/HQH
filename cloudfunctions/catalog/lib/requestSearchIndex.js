'use strict';

async function requestSearchIndex(callFunction, data) {
  if (typeof callFunction !== 'function') {
    return { ok: false, code: 'FAIL' };
  }
  try {
    const res = await callFunction({ name: 'search', data });
    return (res && res.result) || { ok: false, code: 'FAIL' };
  } catch (error) {
    return { ok: false, code: 'FAIL' };
  }
}

module.exports = {
  requestSearchIndex,
};
