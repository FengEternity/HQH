'use strict';

const LOAD_MESSAGE = '目录暂时打不开，请再试一次';
const SEARCH_MESSAGE = '搜索暂时不可用，请再试一次';

function visitorCatalogMessage(kind) {
  return kind === 'search' ? SEARCH_MESSAGE : LOAD_MESSAGE;
}

function shouldAutoRetryCatalog(err) {
  const code = err && err.code;
  return code !== 'FUNCTION_NOT_FOUND' && code !== 'FUNCTION_DEPS_MISSING';
}

async function callWithVisitorRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!shouldAutoRetryCatalog(err)) {
      throw err;
    }
    return fn();
  }
}

module.exports = {
  visitorCatalogMessage,
  shouldAutoRetryCatalog,
  callWithVisitorRetry,
};
