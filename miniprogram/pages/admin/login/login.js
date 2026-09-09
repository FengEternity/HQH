const { catalog, setTicket } = require('../../../utils/api');

Page({
  data: { pin: '' },
  onPin(e) {
    this.setData({ pin: e.detail.value });
  },
  onLogin() {
    catalog({ action: 'adminLogin', pin: this.data.pin })
      .then((res) => {
        setTicket(res.ticket);
        wx.redirectTo({ url: '/pages/admin/home/home' });
      })
      .catch((err) => {
        wx.showToast({ title: err.message || '登录失败', icon: 'none' });
      });
  },
});
