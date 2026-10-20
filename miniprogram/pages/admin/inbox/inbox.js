const { ticketingAdmin } = require('../../../utils/api');

function notifyLabelText(bound, enabled) {
  if (!bound) {
    return '未绑定';
  }
  if (!enabled) {
    return '未开启';
  }
  return '接收中';
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

function hasWecomLogin() {
  return Boolean(wx.qy && wx.qy.login);
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
    notifyBound: false,
    notifyLabel: '未开启',
    notifyEnabled: false,
  },
  onShow() {
    return Promise.all([this.load(), this.loadNotifyTemplate()]);
  },
  applyNotify(bound, enabled) {
    this.setData({
      notifyBound: Boolean(bound),
      notifyEnabled: Boolean(enabled),
      notifyLabel: notifyLabelText(bound, enabled),
    });
  },
  loadNotifyTemplate() {
    return ticketingAdmin({ action: 'csNotifyConfig' })
      .then((result) => {
        if (result) {
          this.applyNotify(result.bound, result.enabled);
        }
      })
      .catch(() => {});
  },
  toggleNotify(e) {
    const enabled = Boolean(e && e.detail && e.detail.value);
    if (!this.data.notifyBound) {
      if (!enabled) {
        return;
      }
      if (!hasWecomLogin()) {
        this.setData({ notifyEnabled: false });
        wx.showToast({ title: '请在企业微信中打开后再开启', icon: 'none' });
        return;
      }
      return Promise.resolve()
        .then(() => wx.qy.login())
        .then((res) =>
          ticketingAdmin({
            action: 'csBindWecom',
            code: res && res.code,
          }),
        )
        .then((result) => {
          this.applyNotify(result.bound, result.enabled);
          wx.showToast({ title: '已开启', icon: 'none' });
        })
        .catch(() => {
          wx.showToast({ title: '绑定失败', icon: 'none' });
        });
    }
    return ticketingAdmin({ action: 'csSetNotify', enabled })
      .then((result) => {
        this.applyNotify(result.bound, result.enabled);
        if (enabled) {
          wx.showToast({ title: '已开启', icon: 'none' });
        }
      })
      .catch(() => {
        if (!enabled) {
          wx.showToast({ title: '停止失败', icon: 'none' });
        }
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
