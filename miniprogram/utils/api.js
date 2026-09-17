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

function search(data) {
  return wx.cloud
    .callFunction({
      name: 'search',
      data,
    })
    .then(unwrapCloudResult)
    .catch((err) => {
      throw mapCloudCallError(err, 'search');
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

function shopAdmin(data) {
  return shop(Object.assign({ ticket: getTicket() }, data));
}

module.exports = {
  catalog,
  shop,
  search,
  admin,
  shopAdmin,
  getTicket,
  setTicket,
};
