const { catalog, setTicket, getTicket, admin } = require('../../../utils/api');

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
    catalog({ action: 'adminLogin', pin })
      .then((res) => {
        setTicket(res.ticket);
        wx.redirectTo({ url: '/pages/admin/home/home' });
      })
      .catch((err) => {
        wx.showToast({ title: err.message || '登录失败', icon: 'none' });
      });
  },
});
