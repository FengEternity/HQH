const release = require('../../data/appRelease');
const { normalizeDoc } = require('../../utils/appRelease');
const { ticketing } = require('../../utils/api');

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
  },
  onShow() {
    const doc = normalizeDoc(release);
    this.setData({ version: doc.version });
    return ticketing({ action: 'csGetProfile' })
      .then((result) => this.applyProfile(result))
      .catch(() => {});
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
});

module.exports = { initialOf };
