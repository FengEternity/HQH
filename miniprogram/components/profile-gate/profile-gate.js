const { ticketing } = require('../../utils/api');

function remember(profile) {
  const app = getApp();
  if (app && app.globalData) {
    app.globalData.nickname = profile.nickname || '';
    app.globalData.avatarFileId = profile.avatarFileId || '';
  }
}

function isLocalAvatar(filePath) {
  const path = String(filePath || '').trim();
  return !!path && path.indexOf('cloud://') !== 0;
}

Component({
  data: {
    visible: false,
    canDismiss: false,
    avatarUrl: '',
    nicknameDraft: '',
  },
  pageLifetimes: {
    show() {
      this.load();
    },
  },
  methods: {
    load() {
      const app = getApp();
      const cached = app && app.globalData && String(app.globalData.nickname || '').trim();
      if (cached) {
        const profile = {
          nickname: cached,
          avatarFileId: app.globalData.avatarFileId || '',
        };
        this.setData({ visible: false });
        this.triggerEvent('bound', profile);
        return;
      }
      return ticketing({ action: 'csGetProfile' })
        .then((result) => {
          const nickname = String((result && result.nickname) || '').trim();
          const avatarFileId = String((result && result.avatarFileId) || '').trim();
          if (nickname) {
            remember({ nickname, avatarFileId });
            this.setData({ visible: false });
            this.triggerEvent('bound', { nickname, avatarFileId });
            return;
          }
          this.setData({ visible: true, canDismiss: false, nicknameDraft: '', avatarUrl: '' });
        })
        .catch(() => {
          this.setData({ visible: true, canDismiss: false });
        });
    },
    edit(profile) {
      const nickname = String((profile && profile.nickname) || '').trim();
      const avatarFileId = String((profile && profile.avatarFileId) || '').trim();
      this.setData({
        visible: true,
        canDismiss: true,
        nicknameDraft: nickname,
        avatarUrl: avatarFileId,
      });
    },
    dismiss() {
      if (!this.data.canDismiss) return;
      this.setData({ visible: false });
    },
    onChooseAvatar(e) {
      const avatarUrl = e && e.detail && e.detail.avatarUrl;
      if (avatarUrl) {
        this.setData({ avatarUrl });
      }
    },
    uploadAvatar(filePath) {
      if (!isLocalAvatar(filePath) || !wx.cloud || typeof wx.cloud.uploadFile !== 'function') {
        return Promise.resolve('');
      }
      const cloudPath = 'avatars/' + Date.now() + '-' + Math.floor(Math.random() * 1000) + '.jpg';
      return wx.cloud.uploadFile({ cloudPath, filePath }).then((result) => (result && result.fileID) || '');
    },
    bindProfile(e) {
      const value = e && e.detail && e.detail.value;
      const nickname = String((value && value.nickname) || '').trim();
      if (!nickname) {
        wx.showToast({ title: '请填写昵称', icon: 'none' });
        return;
      }
      return this.uploadAvatar(this.data.avatarUrl)
        .catch(() => '')
        .then((avatarFileId) => ticketing({
          action: 'csBindProfile',
          nickname,
          avatarFileId,
        }).then((result) => ({ result, avatarFileId })))
        .then(({ result, avatarFileId }) => {
          const saved = {
            nickname: String((result && result.nickname) || nickname).trim(),
            avatarFileId: String((result && result.avatarFileId) || avatarFileId || '').trim(),
          };
          remember(saved);
          this.setData({ visible: false });
          this.triggerEvent('bound', saved);
          wx.showToast({ title: '已保存', icon: 'none' });
        })
        .catch(() => {
          wx.showToast({ title: '保存失败', icon: 'none' });
        });
    },
  },
});
