const { admin, ticketingAdmin } = require('../../../utils/api');
const release = require('../../../data/appRelease');
const { normalizeDoc, envLabel } = require('../../../utils/appRelease');

Page({
  data: {
    pendingLabel: '暂无待处理',
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
    return ticketingAdmin({ action: 'csAdminList' })
      .then((inboxRes) => {
        const pending = (inboxRes.threads || []).length;
        this.setData({
          pendingLabel: pending ? pending + ' 条待处理' : '暂无待处理',
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
  openAbout() {
    wx.navigateTo({ url: '/pages/about/about?staff=1' });
  },
  requeuePlayback() {
    wx.showModal({
      title: '重新处理不合格视频',
      content: '把还没通过播放检查的已有视频放进转码队列。已上架的不会下架。',
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        wx.showLoading({ title: '入队中', mask: true });
        admin({ action: 'enqueueNoncompliantVideos' })
          .then((result) => {
            wx.hideLoading();
            wx.showToast({
              title: '已入队 ' + result.enqueued + ' 条',
              icon: 'none',
            });
          })
          .catch((err) => {
            wx.hideLoading();
            if (err.code === 'UNAUTHORIZED') {
              wx.redirectTo({ url: '/pages/admin/login/login' });
              return;
            }
            wx.showToast({ title: err.message || '入队失败', icon: 'none' });
          });
      },
    });
  },
});
