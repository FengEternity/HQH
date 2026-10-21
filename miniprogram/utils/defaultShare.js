'use strict';

const DEFAULT_TITLE = '优度 · 仪器讲解';
const DEFAULT_ROUTE = 'pages/index/index';

function pageQuery(page) {
  const options = (page && page.options) || {};
  return Object.keys(options)
    .filter((key) => options[key] != null && String(options[key]) !== '')
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(options[key]))}`)
    .join('&');
}

function shareTitle(page) {
  const data = (page && page.data) || {};
  const candidates = [
    data.video && data.video.title,
    data.product && data.product.name,
    data.name,
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    const title = String(candidates[i] || '').trim();
    if (title) return title;
  }
  return DEFAULT_TITLE;
}

function shareImage(page) {
  const data = (page && page.data) || {};
  const poster = String((data.video && data.video.posterUrl) || '').trim();
  if (/^https?:\/\//i.test(poster)) return poster;
  return '';
}

function buildShareAppMessage(page) {
  const route = String((page && page.route) || DEFAULT_ROUTE).replace(/^\//, '');
  const query = pageQuery(page);
  const payload = {
    title: shareTitle(page),
    path: `/${route}${query ? `?${query}` : ''}`,
  };
  const imageUrl = shareImage(page);
  if (imageUrl) payload.imageUrl = imageUrl;
  return payload;
}

function buildShareTimeline(page) {
  return {
    title: shareTitle(page),
    query: pageQuery(page),
  };
}

function enableShareMenu() {
  if (typeof wx === 'undefined' || !wx || typeof wx.showShareMenu !== 'function') return;
  wx.showShareMenu({
    menus: ['shareAppMessage', 'shareTimeline'],
  });
}

function applyDefaultShare(config) {
  const next = Object.assign({}, config || {});
  if (typeof next.onShareAppMessage !== 'function') {
    next.onShareAppMessage = function onShareAppMessage() {
      return buildShareAppMessage(this);
    };
  }
  if (typeof next.onShareTimeline !== 'function') {
    next.onShareTimeline = function onShareTimeline() {
      return buildShareTimeline(this);
    };
  }
  const userOnShow = next.onShow;
  next.onShow = function onShow() {
    enableShareMenu();
    if (typeof userOnShow === 'function') {
      return userOnShow.apply(this, arguments);
    }
  };
  return next;
}

module.exports = {
  DEFAULT_TITLE,
  applyDefaultShare,
};
