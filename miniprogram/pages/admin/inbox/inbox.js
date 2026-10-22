const { ticketingAdmin } = require('../../../utils/api');
const { cachedList, rememberList } = require('../csViewCache');

function notifyLabelText(bound, enabled) {
  if (!bound) {
    return '未绑定';
  }
  if (!enabled) {
    return '未开启';
  }
  return '接收中';
}

function userLabel(item) {
  const name = item && String(item.nickname || '').trim();
  if (name) {
    return name;
  }
  return item && item.openid ? '用户 ' + item.openid.slice(-8) : '未知用户';
}

function initialOf(nickname) {
  const name = String(nickname || '').trim();
  return name ? name.slice(0, 1) : '优';
}

function visibleListError(err) {
  const code = err && (err.errCode || err.code);
  const message = String((err && err.message) || '');
  if (
    code === -504003 ||
    code === 'TIME_LIMIT' ||
    /504003|TIME_LIMIT_EXCEEDED|Invoking task timed out/i.test(message)
  ) {
    return '服务响应超时，请再试一次';
  }
  if (!message || /cloud\.callFunction|errCode/i.test(message)) {
    return '会话暂时打不开，请再试一次';
  }
  return message;
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
    filterId: 'live',
    filters: [
      { id: 'live', label: '会话' },
      { id: 'closed', label: '已关闭' },
    ],
    threads: [],
    loading: true,
    loadError: '',
    notifyLabel: '未开启',
  },
  onShow() {
    return Promise.all([this.load(), this.loadNotifyLabel()]);
  },
  loadNotifyLabel() {
    return ticketingAdmin({ action: 'csNotifyConfig' })
      .then((result) => {
        if (!result) {
          return;
        }
        this.setData({
          notifyLabel: notifyLabelText(result.bound, result.enabled),
        });
      })
      .catch(() => {});
  },
  openNotify() {
    wx.navigateTo({ url: '/pages/admin/notify/notify' });
  },
  load() {
    const filterId = this.data.filterId === 'closed' ? 'closed' : 'live';
    const cached = cachedList(filterId);
    if (cached) {
      if (!this.data.threads.length) {
        this.setData({ threads: cached, loading: false });
      }
    } else {
      this.setData({ loading: true });
    }
    return ticketingAdmin({
      action: 'csAdminList',
      status: filterId === 'closed' ? 'closed' : 'active',
    })
      .then((res) => {
        if ((this.data.filterId === 'closed' ? 'closed' : 'live') !== filterId) {
          return;
        }
        const threads = (res.threads || []).map((item) =>
          Object.assign({}, item, {
            timeLabel: formatTime(item.updatedAt),
            userLabel: userLabel(item),
            avatarFileId: item.avatarFileId || '',
            avatarUrl: item.avatarUrl || '',
            initial: initialOf(item.nickname),
          }),
        );
        rememberList(filterId, threads);
        this.setData({
          threads,
          loading: false,
          loadError: '',
        });
      })
      .catch((err) => {
        const loadError = (this.data.threads || []).length ? '' : visibleListError(err);
        this.setData({ loading: false, loadError });
        if (err.code === 'UNAUTHORIZED') {
          wx.redirectTo({ url: '/pages/admin/login/login' });
          return;
        }
        wx.showToast({ title: loadError || err.message || '加载失败', icon: 'none' });
      });
  },
  selectStatus(e) {
    const filterId = e.currentTarget.dataset.filter;
    if (!filterId || filterId === this.data.filterId) {
      return;
    }
    this.setData({ filterId, threads: [], loadError: '' });
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

module.exports = { notifyLabelText, visibleListError };
