const { admin, ticketingAdmin } = require('../../../utils/api');
const release = require('../../../data/appRelease');
const { normalizeDoc, envLabel } = require('../../../utils/appRelease');

Page({
  data: {
    pendingLabel: '暂无待处理',
    aboutHint: '',
    ingestChip: '查看进度',
  },
  onShow() {
    const doc = normalizeDoc(release);
    const account = wx.getAccountInfoSync();
    const mini = account.miniProgram || {};
    this.setData({
      aboutHint: envLabel(mini.envVersion) + ' · ' + doc.version,
    });
    this.load();
    this.loadProgress();
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
  openIngest() {
    wx.navigateTo({ url: '/pages/admin/ingest/ingest' });
  },
  loadProgress() {
    return admin({ action: 'getIngestProgress' })
      .then((result) => {
        const running = result.running || 0;
        const queued = result.queued || 0;
        const failed = result.failed || 0;
        let ingestChip = '暂无排队';
        if (running > 0) {
          ingestChip = '正在转';
        } else if (queued > 0) {
          ingestChip = queued + ' 条排队';
        } else if (failed > 0) {
          ingestChip = failed + ' 条失败';
        }
        this.setData({ ingestChip });
      })
      .catch((err) => {
        if (err.code === 'UNAUTHORIZED') {
          wx.redirectTo({ url: '/pages/admin/login/login' });
        }
      });
  },
});
