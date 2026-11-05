const { catalog } = require('../../../utils/api');

function safeAdminNext(raw) {
  const next = String(raw || '');
  if (!next.startsWith('/pages/admin/')) return '';
  if (next.startsWith('/pages/admin/login')) return '';
  if (next.indexOf('..') >= 0) return '';
  return next;
}

Page({
  data: { pin: '', showPin: true },
  onLoad(query) {
    this._next = safeAdminNext(query && query.next);
  },
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
        wx.redirectTo({ url: this._next || '/pages/admin/home/home' });
      })
      .catch((err) => {
        wx.showToast({ title: err.message || '登录失败', icon: 'none' });
      });
  },
});
