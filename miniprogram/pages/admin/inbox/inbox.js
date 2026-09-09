const { admin } = require('../../../utils/api');

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
    messages: [],
    unreadCount: 0,
    loading: true,
  },
  onShow() {
    this.load();
  },
  load() {
    this.setData({ loading: true });
    admin({ action: 'adminListSupport' })
      .then((res) => {
        const messages = (res.messages || []).map((item) =>
          Object.assign({}, item, {
            statusLabel: item.status === 'unread' ? '未读' : '已读',
            timeLabel: formatTime(item.createdAt),
          }),
        );
        this.setData({
          messages,
          unreadCount: res.unreadCount || 0,
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
  markRead(e) {
    const id = e.currentTarget.dataset.id;
    const found = this.data.messages.find((item) => item._id === id);
    if (!found || found.status === 'read') {
      return;
    }
    admin({ action: 'adminReadSupport', id })
      .then(() => this.load())
      .catch((err) => wx.showToast({ title: err.message || '标记失败', icon: 'none' }));
  },
});
