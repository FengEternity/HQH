'use strict';

const lists = {
  live: null,
  closed: null,
};

const threads = new Map();

function rememberList(filterId, rows) {
  if (filterId === 'live' || filterId === 'closed') {
    lists[filterId] = rows;
  }
}

function cachedList(filterId) {
  if (filterId !== 'live' && filterId !== 'closed') {
    return null;
  }
  return lists[filterId];
}

function rememberThread(threadId, result) {
  if (threadId) {
    threads.set(threadId, result);
  }
}

function cachedThread(threadId) {
  return threads.get(threadId) || null;
}

function clearCsViewCache() {
  lists.live = null;
  lists.closed = null;
  threads.clear();
}

module.exports = {
  rememberList,
  cachedList,
  rememberThread,
  cachedThread,
  clearCsViewCache,
};
