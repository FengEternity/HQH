const { mapCloudCallError } = require('./mapCloudCallError');

function unwrapCloudResult(res) {
  const result = res.result;
  if (!result || result.ok === false) {
    const err = new Error((result && result.message) || '请求失败');
    err.code = result && result.code;
    throw err;
  }
  return result;
}

function catalog(data) {
  return wx.cloud
    .callFunction({
      name: 'catalog',
      data,
    })
    .then(unwrapCloudResult)
    .catch((err) => {
      throw mapCloudCallError(err, 'catalog');
    });
}

function shop(data) {
  return wx.cloud
    .callFunction({
      name: 'shop',
      data,
    })
    .then(unwrapCloudResult)
    .catch((err) => {
      throw mapCloudCallError(err, 'shop');
    });
}

function ticketing(data) {
  return wx.cloud
    .callFunction({ name: 'ticketing', data })
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
      throw mapCloudCallError(err, 'ticketing');
    });
}

function agent(data) {
  return wx.cloud
    .callFunction({ name: 'agent', data })
    .then(unwrapCloudResult)
    .catch((err) => {
      throw mapCloudCallError(err, 'agent');
    });
}

function admin(data) {
  return catalog(data);
}

function ticketingAdmin(data) {
  return ticketing(data);
}

function shopAdmin(data) {
  return shop(data);
}

function adminMe() {
  return catalog({ action: 'adminMe' });
}

module.exports = {
  catalog,
  ticketing,
  shop,
  agent,
  admin,
  ticketingAdmin,
  shopAdmin,
  adminMe,
};
