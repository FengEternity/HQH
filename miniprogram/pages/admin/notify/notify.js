const { ticketingAdmin } = require('../../../utils/api');

function notifyLabelText(bound, enabled) {
  if (!bound) {
    return '未绑定';
  }
  if (!enabled) {
    return '未开启';
  }
  return '接收中';
}

Page({
  data: {
    notifyBound: false,
    notifyLabel: '未开启',
    notifyEnabled: false,
    notifyError: '',
    notifyMobile: '',
    notifyBoundMobile: '',
    notifyHint: '',
    notifyChanging: false,
  },
  onShow() {
    return this.loadNotifyTemplate();
  },
  applyNotify(result) {
    const bound = Boolean(result && result.bound);
    const enabled = Boolean(result && result.enabled);
    this.setData({
      notifyBound: bound,
      notifyEnabled: enabled,
      notifyBoundMobile: (result && result.mobile) || '',
      notifyLabel: notifyLabelText(bound, enabled),
      notifyError: '',
      notifyHint: '',
      notifyChanging: false,
    });
  },
  finishBind(result) {
    this.applyNotify(result);
    if (result && result.testSent === false) {
      this.setData({ notifyError: result.message || '已绑定，但测试消息没发到群' });
      wx.showToast({ title: '测试未发出', icon: 'none' });
      return;
    }
    if (result && result.message) {
      this.setData({ notifyHint: result.message });
    }
    wx.showToast({ title: '已开启', icon: 'none' });
  },
  bindMobile(mobile) {
    return ticketingAdmin({
      action: 'csBindWecom',
      mobile,
    })
      .then((result) => {
        this.finishBind(result);
      })
      .catch((err) => {
        if (err.code === 'UNAUTHORIZED') {
          this.restoreNotifyEnabled();
          wx.switchTab({ url: '/pages/mine/mine' });
          return;
        }
        this.showBindError(err);
      });
  },
  showBindError(err) {
    const detail = (err && err.message) || '绑定失败';
    this.restoreNotifyEnabled();
    this.setData({ notifyError: detail });
    wx.showToast({ title: '绑定失败', icon: 'none' });
  },
  loadNotifyTemplate() {
    return ticketingAdmin({ action: 'csNotifyConfig' })
      .then((result) => {
        if (result) {
          this.applyNotify(result);
        }
      })
      .catch((err) => {
        if (err.code === 'UNAUTHORIZED') {
          wx.switchTab({ url: '/pages/mine/mine' });
        }
      });
  },
  restoreNotifyEnabled() {
    const notifyEnabled = this.data.notifyEnabled;
    this.setData({ notifyEnabled: !notifyEnabled }, () => {
      this.setData({ notifyEnabled });
    });
  },
  startChangeMobile() {
    this.setData({
      notifyChanging: true,
      notifyMobile: '',
      notifyError: '',
      notifyHint: '',
    });
  },
  confirmChangeMobile() {
    const mobile = String(this.data.notifyMobile || '').trim();
    if (!/^1\d{10}$/.test(mobile)) {
      this.setData({ notifyError: '请填写企业微信里的11位手机号' });
      wx.showToast({ title: '绑定失败', icon: 'none' });
      return;
    }
    return this.bindMobile(mobile);
  },
  onNotifyMobile(e) {
    this.setData({ notifyMobile: e.detail.value });
  },
  toggleNotify(e) {
    const enabled = Boolean(e && e.detail && e.detail.value);
    if (!this.data.notifyBound) {
      if (!enabled) {
        return;
      }
      const mobile = String(this.data.notifyMobile || '').trim();
      if (!/^1\d{10}$/.test(mobile)) {
        this.restoreNotifyEnabled();
        this.setData({ notifyError: '请填写企业微信里的11位手机号' });
        wx.showToast({ title: '绑定失败', icon: 'none' });
        return;
      }
      return this.bindMobile(mobile);
    }
    return ticketingAdmin({ action: 'csSetNotify', enabled })
      .then((result) => {
        if (enabled) {
          this.finishBind(result);
          return;
        }
        this.applyNotify(result);
      })
      .catch((err) => {
        this.restoreNotifyEnabled();
        if (err.code === 'UNAUTHORIZED') {
          wx.switchTab({ url: '/pages/mine/mine' });
          return;
        }
        if (!enabled) {
          wx.showToast({ title: '停止失败', icon: 'none' });
        }
      });
  },
});

module.exports = { notifyLabelText };
