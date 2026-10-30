const { admin, ticketingAdmin } = require('../../../utils/api');
const release = require('../../../data/appRelease');
const { normalizeDoc, envLabel } = require('../../../utils/appRelease');
const { ingestEntryLabel } = require('../../../utils/ingestEntryLabel');

Page({
  data: {
    pendingLabel: '暂无未读',
    aboutHint: '',
    ingestLabel: '进入',
  },
  onShow() {
    const doc = normalizeDoc(release);
    const account = wx.getAccountInfoSync();
    const mini = account.miniProgram || {};
    this.setData({
      aboutHint: envLabel(mini.envVersion) + ' · ' + doc.version,
    });
    return Promise.all([this.load(), this.loadProgress()]);
  },
  load() {
    return ticketingAdmin({ action: 'csAdminList' })
      .then((inboxRes) => {
        const pending = (inboxRes.threads || []).filter((item) => item.unread).length;
        this.setData({
          pendingLabel: pending ? pending + ' 条未读' : '暂无未读',
        });
      })
      .catch((err) => {
        this.setData({ pendingLabel: '工单加载失败' });
        const title = err.code === 'UNAUTHORIZED'
          ? '工单加载失败'
          : (err.message || '工单加载失败');
        wx.showToast({ title, icon: 'none' });
      });
  },
  loadProgress() {
    return admin({ action: 'getIngestProgress' })
      .then((result) => {
        this.setData({
          ingestLabel: ingestEntryLabel({
            running: result.running,
            queued: result.queued,
            failed: result.failed,
          }),
        });
      })
      .catch((err) => {
        if (err && err.code === 'UNAUTHORIZED') {
          wx.redirectTo({ url: '/pages/admin/login/login' });
          return;
        }
        this.setData({
          ingestLabel: ingestEntryLabel({ failedToLoad: true }),
        });
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
});
