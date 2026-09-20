const {
  catalog,
  setTicket,
  getTicket,
  admin,
  csAdmin,
} = require('../../../utils/api');
const { contact } = require('../../../config.js');

function requestNewTicketSubscription() {
  const tmplId = contact && contact.newTicketTplId;
  if (!tmplId) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      const request = wx.requestSubscribeMessage({
        tmplIds: [tmplId],
        success: done,
        fail: done,
      });
      if (request && typeof request.then === 'function') {
        request.then(done, done);
      }
    } catch (err) {
      done();
    }
  });
}

Page({
  data: { pin: '' },
  onShow() {
    const ticket = getTicket();
    if (!ticket) {
      return;
    }
    admin({ action: 'adminListBrands' })
      .then(() => {
        wx.redirectTo({ url: '/pages/admin/home/home' });
      })
      .catch(() => {});
  },
  onPin(e) {
    this.setData({ pin: e.detail.value });
  },
  onLogin() {
    const pin = (this.data.pin || '').trim();
    if (!pin) {
      wx.showToast({ title: '请输入口令', icon: 'none' });
      return;
    }
    return catalog({ action: 'adminLogin', pin })
      .then((res) => {
        setTicket(res.ticket);
        return requestNewTicketSubscription()
          .then(() =>
            csAdmin({ action: 'csRegisterNotify' }).catch(() => {}),
          )
          .then(() => {
            wx.redirectTo({ url: '/pages/admin/home/home' });
          });
      })
      .catch((err) => {
        wx.showToast({ title: err.message || '登录失败', icon: 'none' });
      });
  },
});
