const { admin } = require('../../../utils/api');
const release = require('../../../data/appRelease');
const { normalizeDoc, envLabel } = require('../../../utils/appRelease');

Page({
  data: {
    unreadLabel: '暂无未读',
    aboutHint: '',
  },
  onShow() {
    const doc = normalizeDoc(release);
    const account = wx.getAccountInfoSync();
    const mini = account.miniProgram || {};
    this.setData({
      aboutHint: envLabel(mini.envVersion) + ' · ' + doc.version,
    });
    this.load();
  },
  load() {
    admin({ action: 'adminListSupport' })
      .then((inboxRes) => {
        const unread = inboxRes.unreadCount || 0;
        this.setData({
          unreadLabel: unread ? unread + ' 条未读' : '暂无未读',
        });
      })
      .catch((err) => {
        if (err.code === 'UNAUTHORIZED') {
          wx.redirectTo({ url: '/pages/admin/login/login' });
        }
      });
  },
  openCatalog() {
    wx.navigateTo({ url: '/pages/admin/catalog/catalog' });
  },
  openInbox() {
    wx.navigateTo({ url: '/pages/admin/inbox/inbox' });
  },
  openAbout() {
    wx.navigateTo({ url: '/pages/about/about?staff=1' });
  },
});
