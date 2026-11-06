'use strict';

async function requestSearchIndex(callFunction, data) {
  if (typeof callFunction !== 'function') {
    return { ok: false, code: 'FAIL' };
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await callFunction({ name: 'search', data });
      const result = (res && res.result) || { ok: false, code: 'FAIL' };
      if (result.ok !== false || result.code === 'BAD_INPUT' || attempt === 1) {
        return result;
      }
    } catch (error) {
      if (attempt === 1) {
        return { ok: false, code: 'FAIL' };
      }
    }
  }
  return { ok: false, code: 'FAIL' };
}

module.exports = {
  requestSearchIndex,
};
