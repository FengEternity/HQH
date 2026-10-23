const { catalog } = require('../../../utils/api');

Page({
  data: { pin: '', showPin: true },
  onShow() {
    this.setData({ showPin: true });
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
      .then(() => {
        wx.redirectTo({ url: '/pages/admin/home/home' });
      })
      .catch((err) => {
        wx.showToast({ title: err.message || '登录失败', icon: 'none' });
      });
  },
});
