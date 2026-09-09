const { admin } = require('../../../utils/api');

Page({
  data: {
    unreadLabel: '暂无未读',
  },
  onShow() {
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
  openShop() {
    wx.navigateTo({ url: '/pages/admin/shop/shop' });
  },
  openInbox() {
    wx.navigateTo({ url: '/pages/admin/inbox/inbox' });
  },
});
