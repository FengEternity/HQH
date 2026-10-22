const release = require('../../data/appRelease');
const { normalizeDoc } = require('../../utils/appRelease');
const { ticketing, adminMe } = require('../../utils/api');

function initialOf(nickname) {
  const name = String(nickname || '').trim();
  return name ? name.slice(0, 1) : '优';
}

Page({
  data: {
    version: '未知',
    nickname: '',
    avatarFileId: '',
    initial: '优',
    showAdmin: false,
  },
  onShow() {
    const doc = normalizeDoc(release);
    this.setData({
      version: doc.version,
      showAdmin: false,
    });
    const profile = ticketing({ action: 'csGetProfile' })
      .then((result) => this.applyProfile(result))
      .catch(() => {});
    const identity = adminMe()
      .then((result) => {
        this.setData({ showAdmin: Boolean(result.enabled) });
      })
      .catch(() => {});
    return Promise.all([profile, identity]);
  },
  onProfileBound(e) {
    this.applyProfile(e && e.detail);
  },
  applyProfile(profile) {
    const nickname = String((profile && profile.nickname) || '').trim();
    const avatarFileId = String((profile && profile.avatarFileId) || '').trim();
    this.setData({
      nickname,
      avatarFileId,
      initial: initialOf(nickname),
    });
  },
  editProfile() {
    const gate = this.selectComponent('#profileGate');
    if (!gate || typeof gate.edit !== 'function') return;
    gate.edit({
      nickname: this.data.nickname,
      avatarFileId: this.data.avatarFileId,
    });
  },
  openAdmin() {
    wx.navigateTo({ url: '/pages/admin/home/home' });
  },
});

module.exports = { initialOf };
