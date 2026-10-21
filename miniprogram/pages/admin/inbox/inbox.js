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
    notifyBound: false,
    notifyLabel: '未开启',
    notifyEnabled: false,
    notifyError: '',
    notifyMobile: '',
  },
  onShow() {
    return Promise.all([this.load(), this.loadNotifyTemplate()]);
  },
  applyNotify(bound, enabled) {
    this.setData({
      notifyBound: Boolean(bound),
      notifyEnabled: Boolean(enabled),
      notifyLabel: notifyLabelText(bound, enabled),
      notifyError: '',
    });
  },
  showBindError(err) {
    const detail = (err && err.message) || '绑定失败';
    this.restoreNotifyEnabled();
    this.setData({ notifyError: detail });
    wx.showToast({ title: '绑定失败', icon: 'none' });
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
  restoreNotifyEnabled() {
    const notifyEnabled = this.data.notifyEnabled;
    this.setData({ notifyEnabled: !notifyEnabled }, () => {
      this.setData({ notifyEnabled });
    });
  },
  toggleNotify(e) {
    const enabled = Boolean(e && e.detail && e.detail.value);
    if (!this.data.notifyBound) {
      if (!enabled) {
        return;
      }
      const mobile = String(this.data.notifyMobile || '').trim();
      if (!/^1\d{10}$/.test(mobile)) {
        this.restoreNotifyEnabled();
        this.setData({ notifyError: '请填写企业微信里的11位手机号' });
        wx.showToast({ title: '绑定失败', icon: 'none' });
        return;
      }
      return ticketingAdmin({
        action: 'csBindWecom',
        mobile,
      })
        .then((result) => {
          this.applyNotify(result.bound, result.enabled);
          wx.showToast({ title: '已开启', icon: 'none' });
        })
        .catch((err) => {
          this.showBindError(err);
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
        this.restoreNotifyEnabled();
        if (!enabled) {
          wx.showToast({ title: '停止失败', icon: 'none' });
        }
      });
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
            initial: initialOf(item.nickname),
          }),
        );
        rememberList(filterId, threads);
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
    const filterId = e.currentTarget.dataset.filter;
    if (!filterId || filterId === this.data.filterId) {
      return;
    }
    this.setData({ filterId, threads: [] });
    return this.load();
  },
  onNotifyMobile(e) {
    this.setData({ notifyMobile: e.detail.value });
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
