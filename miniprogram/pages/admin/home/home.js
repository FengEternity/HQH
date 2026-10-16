const { admin, ticketingAdmin } = require('../../../utils/api');
const { contact } = require('../../../config.js');
const release = require('../../../data/appRelease');
const { normalizeDoc, envLabel } = require('../../../utils/appRelease');

function notifyLabelText(templateId, enabled, quota) {
  if (!templateId) {
    return '未配置';
  }
  if (!enabled) {
    return '未开启';
  }
  if (Number(quota) > 0) {
    return '还可接收 ' + quota + ' 条';
  }
  return '额度已用完';
}

Page({
  data: {
    pendingLabel: '暂无待处理',
    aboutHint: '',
    ingestChip: '查看进度',
    newTicketTplId: (contact && contact.newTicketTplId) || '',
    notifyLabel: '未开启',
    notifyEnabled: false,
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
  applyNotify(templateId, enabled, quota) {
    this.setData({
      newTicketTplId: templateId || '',
      notifyEnabled: Boolean(enabled),
      notifyLabel: notifyLabelText(templateId, enabled, quota),
    });
  },
  loadNotifyTemplate() {
    return ticketingAdmin({ action: 'csNotifyConfig' })
      .then((result) => {
        if (result) {
          this.applyNotify(result.newTicketTplId, result.enabled, result.quota);
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
      if (!result || result[templateId] !== 'accept') {
        wx.showToast({ title: '未允许，这个微信收不到通知', icon: 'none' });
        return;
      }
      return ticketingAdmin({ action: 'csRegisterNotify' })
        .then((registered) => {
          this.applyNotify(templateId, registered.enabled, registered.quota);
          wx.showToast({
            title: '已开启，还可接收 ' + registered.quota + ' 条',
            icon: 'none',
          });
        })
        .catch(() => {
          wx.showToast({ title: '通知状态更新失败', icon: 'none' });
        });
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
        return request.then((result) => finish(result), () => finish(null));
      }
      return pending;
    } catch (err) {
      return finish(null);
    }
  },
  stopNotify() {
    return ticketingAdmin({ action: 'csUnregisterNotify' })
      .then((result) => {
        this.applyNotify(this.data.newTicketTplId, result.enabled, result.quota);
      })
      .catch(() => {
        wx.showToast({ title: '停止失败', icon: 'none' });
      });
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

module.exports = { notifyLabelText };
