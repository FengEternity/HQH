const { useLocalCatalog } = require('../config.js');
const { catalogMock } = require('./mockCatalog.js');

function isMockMode() {
  if (useLocalCatalog) {
    return true;
  }
  try {
    const account = wx.getAccountInfoSync();
    const appId = account.miniProgram && account.miniProgram.appId;
    if (!appId || appId === 'touristappid') {
      return true;
    }
  } catch (error) {
    return true;
  }
  if (!wx.cloud) {
    return true;
  }
  return false;
}

function isCloudNotReadyError(err) {
  const msg = String((err && (err.errMsg || err.message)) || '');
  return (
    msg.indexOf('-601034') >= 0 ||
    msg.indexOf('没有权限') >= 0 ||
    msg.indexOf('开通云开发') >= 0 ||
    msg.indexOf('cloud init') >= 0
  );
}

function catalog(data) {
  if (isMockMode()) {
    return catalogMock(data);
  }
  return wx.cloud
    .callFunction({
      name: 'catalog',
      data,
    })
    .then((res) => {
      const result = res.result;
      if (!result || result.ok === false) {
        const err = new Error((result && result.message) || '请求失败');
        err.code = result && result.code;
        throw err;
      }
      return result;
    })
    .catch((err) => {
      // 真实 AppID 但未开通云开发时，回退本地目录，避免首页整页报错
      if (isCloudNotReadyError(err)) {
        return catalogMock(data);
      }
      throw err;
    });
}

function getTicket() {
  return wx.getStorageSync('hqh_admin_ticket') || '';
}

function setTicket(ticket) {
  wx.setStorageSync('hqh_admin_ticket', ticket);
}

function admin(data) {
  return catalog(Object.assign({ ticket: getTicket() }, data));
}

function localAdmin(path, body) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: 'http://127.0.0.1:8787' + path,
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        'X-Admin-Token': 'preview-admin',
      },
      data: body || {},
      success: (res) => resolve(res.data || {}),
      fail: () => {
        const err = new Error('请先运行 node scripts/preview-server.js');
        err.code = 'LOCAL_SERVER';
        reject(err);
      },
    });
  });
}

function aiSearchMessage(code, fallback) {
  switch (code) {
    case 'NO_INDEX':
      return '请先运行 node scripts/embed-catalog.js';
    case 'NO_API_KEY':
      return '未配置 OPENAI_API_KEY';
    case 'NO_API_BASE':
      return '未配置 OPENAI_BASE_URL';
    case 'BAD_INPUT':
      return '请输入问题';
    case 'EMBED_FAIL':
      return fallback || '向量化失败，请确认网关支持 embeddings';
    case 'LOCAL_SERVER':
      return '请先运行 node scripts/preview-server.js';
    default: {
      return fallback || 'AI 搜索失败';
    }
  }
}

function aiSearch(query, brandId) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: 'http://127.0.0.1:8787/api/ai-search',
      method: 'POST',
      header: { 'Content-Type': 'application/json' },
      data: { query, brandId: brandId || '' },
      success: (res) => {
        const body = res.data || {};
        if (!body.ok) {
          const err = new Error(aiSearchMessage(body.code, body.message));
          err.code = body.code;
          reject(err);
          return;
        }
        resolve(body);
      },
      fail: () => {
        const err = new Error(aiSearchMessage('LOCAL_SERVER'));
        err.code = 'LOCAL_SERVER';
        reject(err);
      },
    });
  });
}

module.exports = {
  catalog,
  admin,
  getTicket,
  setTicket,
  isMockMode,
  localAdmin,
  aiSearch,
};
