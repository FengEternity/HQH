const { ticketingAdmin } = require('../../../utils/api');

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

function roleLabel(role) {
  if (role === 'user') {
    return '用户';
  }
  if (role === 'operator') {
    return '运营';
  }
  return '客服';
}

function statusLabel(status) {
  const labels = {
    open: '自动应答',
    waiting_human: '待处理',
    human: '处理中',
    closed: '已关闭',
  };
  return labels[status] || '未知状态';
}

function userLabel(openid) {
  return openid ? '用户 ' + openid.slice(-8) : '未知用户';
}

function mapThread(thread) {
  return Object.assign({}, thread, {
    statusLabel: statusLabel(thread.status),
    userLabel: userLabel(thread.openid),
  });
}

Page({
  data: {
    threadId: '',
    thread: null,
    messages: [],
    draft: '',
    loading: true,
    submitting: false,
  },
  onLoad(options) {
    this.setData({ threadId: options.id || '' });
  },
  onShow() {
    if (this.data.threadId) {
      return this.load();
    }
    this.setData({ loading: false });
  },
  load() {
    this.setData({ loading: true });
    return ticketingAdmin({
      action: 'csAdminGet',
      threadId: this.data.threadId,
    })
      .then((result) => this.applyResult(result))
      .catch((err) => this.showError(err));
  },
  applyResult(result) {
    const messages = (result.messages || []).map((item) =>
      Object.assign({}, item, {
        roleLabel: roleLabel(item.role),
        timeLabel: formatTime(item.createdAt),
      }),
    );
    this.setData({
      thread: mapThread(result.thread),
      messages,
      loading: false,
      submitting: false,
    });
  },
  showError(err) {
    this.setData({ loading: false, submitting: false });
    if (err.code === 'UNAUTHORIZED') {
      wx.redirectTo({ url: '/pages/admin/login/login' });
      return;
    }
    wx.showToast({ title: err.message || '请求失败', icon: 'none' });
  },
  onDraft(e) {
    this.setData({ draft: e.detail.value });
  },
  reply() {
    const text = (this.data.draft || '').trim();
    if (!text || this.data.submitting) {
      return;
    }
    this.setData({ submitting: true });
    return ticketingAdmin({
      action: 'csAdminReply',
      threadId: this.data.threadId,
      text,
    })
      .then((result) => {
        this.setData({ draft: '' });
        this.applyResult(result);
      })
      .catch((err) => this.showError(err));
  },
  close() {
    if (this.data.submitting || !this.data.thread) {
      return;
    }
    wx.showModal({
      title: '关闭工单',
      content: '关闭后用户再次发消息会创建新工单。',
      success: (result) => {
        if (!result.confirm) {
          return;
        }
        this.setData({ submitting: true });
        ticketingAdmin({
          action: 'csAdminClose',
          threadId: this.data.threadId,
        })
          .then((response) => {
            this.setData({
              thread: mapThread(response.thread),
              submitting: false,
            });
          })
          .catch((err) => this.showError(err));
      },
    });
  },
});
