const { ticketingAdmin } = require('../../../utils/api');
const { contact } = require('../../../config.js');

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

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatTime(ms) {
  const d = new Date(Number(ms) || 0);
  if (!ms) {
    return '';
  }
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes())
  );
}

Page({
  data: {
    status: 'waiting_human',
    statuses: [
      { value: 'waiting_human', label: '待处理' },
      { value: 'human', label: '处理中' },
      { value: 'closed', label: '已关闭' },
    ],
    threads: [],
    loading: true,
    newTicketTplId: (contact && contact.newTicketTplId) || '',
    notifyLabel: '未开启',
    notifyEnabled: false,
  },
  onShow() {
    return Promise.all([this.load(), this.loadNotifyTemplate()]);
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
  load() {
    this.setData({ loading: true });
    return ticketingAdmin({ action: 'csAdminList', status: this.data.status })
      .then((res) => {
        const threads = (res.threads || []).map((item) =>
          Object.assign({}, item, {
            timeLabel: formatTime(item.updatedAt),
            userLabel: item.openid
              ? '用户 ' + item.openid.slice(-8)
              : '未知用户',
          }),
        );
        this.setData({
          threads,
          loading: false,
        });
      })
      .catch((err) => {
        this.setData({ loading: false });
        if (err.code === 'UNAUTHORIZED') {
          wx.redirectTo({ url: '/pages/admin/login/login' });
          return;
        }
        wx.showToast({ title: err.message || '加载失败', icon: 'none' });
      });
  },
  selectStatus(e) {
    const status = e.currentTarget.dataset.status;
    if (!status || status === this.data.status) {
      return;
    }
    this.setData({ status, threads: [] });
    return this.load();
  },
  openTicket(e) {
    const id = e.currentTarget.dataset.id;
    if (id) {
      wx.navigateTo({
        url: '/pages/admin/ticket/ticket?id=' + encodeURIComponent(id),
      });
    }
  },
});

module.exports = { notifyLabelText };
