const { csAdmin } = require('../../../utils/api');

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
  },
  onShow() {
    this.load();
  },
  load() {
    this.setData({ loading: true });
    return csAdmin({ action: 'csAdminList', status: this.data.status })
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
