function catalog(data) {
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
    });
}

function cs(data) {
  return wx.cloud
    .callFunction({ name: 'cs', data })
    .then((res) => {
      const result = res.result;
      if (!result || result.ok === false) {
        const err = new Error((result && result.message) || '请求失败');
        err.code = result && result.code;
        throw err;
      }
      return result;
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

function csAdmin(data) {
  return cs(Object.assign({ ticket: getTicket() }, data));
}

module.exports = {
  catalog,
  cs,
  admin,
  csAdmin,
  getTicket,
  setTicket,
};
