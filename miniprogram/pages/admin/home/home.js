const { admin, ticketingAdmin } = require('../../../utils/api');
const { contact } = require('../../../config.js');
const release = require('../../../data/appRelease');
const { normalizeDoc, envLabel } = require('../../../utils/appRelease');

Page({
  data: {
    pendingLabel: '暂无待处理',
    aboutHint: '',
    ingestChip: '查看进度',
    newTicketTplId: (contact && contact.newTicketTplId) || '',
    notifyLabel: '去绑定',
  },
  onShow() {
    const doc = normalizeDoc(release);
    const account = wx.getAccountInfoSync();
    const mini = account.miniProgram || {};
    this.setData({
      aboutHint: envLabel(mini.envVersion) + ' · ' + doc.version,
    });
    this.load();
    this.loadNotifyTemplate();
    this.loadProgress();
  },
  loadNotifyTemplate() {
    return ticketingAdmin({ action: 'csNotifyConfig' })
      .then((result) => {
        const templateId = result && result.newTicketTplId;
        if (templateId) {
          this.setData({ newTicketTplId: templateId });
        }
      })
      .catch(() => {});
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
          return;
        }
        this.setData({ pendingLabel: '工单加载失败' });
        wx.showToast({ title: err.message || '工单加载失败', icon: 'none' });
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
  bindNotify() {
    const templateId = this.data.newTicketTplId;
    if (!templateId) {
      wx.showToast({ title: '未配置通知模板', icon: 'none' });
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      const accepted = result && result[templateId] === 'accept';
      this.setData({ notifyLabel: accepted ? '已允许' : '未允许' });
      wx.showToast({
        title: accepted ? '已绑定，可接收一条新工单通知' : '未允许，这个微信收不到通知',
        icon: 'none',
      });
      return ticketingAdmin({ action: 'csRegisterNotify' }).catch(() => {});
    };
    try {
      let pending;
      const request = wx.requestSubscribeMessage({
        tmplIds: [templateId],
        success: (result) => {
          pending = finish(result);
        },
        fail: () => {
          pending = finish(null);
        },
      });
      if (request && typeof request.then === 'function') {
        return request.then(
          (result) => finish(result),
          () => finish(null),
        );
      }
      return pending;
    } catch (err) {
      return finish(null);
    }
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
