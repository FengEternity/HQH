const release = require('../../data/app-release.json');
const { normalizeDoc } = require('../../utils/appRelease');

Page({
  data: {
    version: '未知',
  },
  onShow() {
    const doc = normalizeDoc(release);
    this.setData({ version: doc.version });
  },
  openAbout() {
    wx.navigateTo({ url: '/pages/about/about' });
  },
});
