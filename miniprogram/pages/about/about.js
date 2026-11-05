const { adminMe } = require('../../utils/api');
const release = require('../../data/appRelease');
const {
  buildAboutView,
  clipboardText,
  isStaffMode,
} = require('../../utils/appRelease');

Page({
  data: {
    productName: '',
    version: '',
    envLabel: '',
    wxVersion: '',
    showWxRow: false,
    wxLine: '',
    releases: [],
    emptyHint: '',
    staff: false,
  },
  onLoad(query) {
    const staff = isStaffMode(query);
    if (!staff) {
      this.applyView(false);
      return;
    }
    return adminMe()
      .then((identity) => {
        if (!identity.enabled) {
          wx.switchTab({ url: '/pages/mine/mine' });
          return;
        }
        this.applyView(true);
      })
      .catch(() => {
        wx.switchTab({ url: '/pages/mine/mine' });
      });
  },
  applyView(staff) {
    const view = buildAboutView({
      doc: release,
      accountInfo: wx.getAccountInfoSync(),
      staff,
    });
    this.setData(Object.assign({ staff }, view));
  },
  copyVersion() {
    const text = clipboardText({
      version: this.data.version,
      envLabel: this.data.envLabel,
      staff: this.data.staff,
      wxVersion: this.data.wxVersion,
    });
    wx.setClipboardData({
      data: text,
      success() {
        wx.showToast({ title: '已复制', icon: 'none' });
      },
      fail() {
        wx.showToast({ title: '复制失败', icon: 'none' });
      },
    });
  },
});
