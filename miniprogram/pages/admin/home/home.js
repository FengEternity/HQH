const { admin, adminMe, ticketingAdmin } = require('../../../utils/api');
const release = require('../../../data/appRelease');
const { normalizeDoc, envLabel } = require('../../../utils/appRelease');
const { ingestEntryLabel } = require('../../../utils/ingestEntryLabel');

Page({
  data: {
    pendingLabel: '暂无未读',
    aboutHint: '',
    ingestLabel: '进入',
    role: '',
  },
  onShow() {
    const doc = normalizeDoc(release);
    const account = wx.getAccountInfoSync();
    const mini = account.miniProgram || {};
    this.setData({
      aboutHint: envLabel(mini.envVersion) + ' · ' + doc.version,
    });
    return adminMe()
      .then((identity) => {
        if (!identity.enabled) {
          this.setData({ role: '' });
          wx.switchTab({ url: '/pages/mine/mine' });
          return;
        }
        this.setData({ role: identity.role || '' });
        return Promise.all([this.load(), this.loadProgress()]);
      })
      .catch(() => {
        wx.switchTab({ url: '/pages/mine/mine' });
      });
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
        if (err.code === 'UNAUTHORIZED') {
          wx.redirectTo({ url: '/pages/admin/login/login' });
          return;
        }
        this.setData({ pendingLabel: '工单加载失败' });
        wx.showToast({ title: err.message || '工单加载失败', icon: 'none' });
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
  openStaff() {
    if (this.data.role !== 'admin') return;
    wx.navigateTo({ url: '/pages/admin/staff/staff' });
  },
  openAbout() {
    wx.navigateTo({ url: '/pages/about/about?staff=1' });
  },
});
