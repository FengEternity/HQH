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

function bubbleSide(role) {
  if (role === 'user') {
    return 'in';
  }
  if (role === 'operator') {
    return 'out';
  }
  return 'notice';
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

const CLAIM_WINDOW_MS = 600000;

function claimState(thread, openid, now) {
  const holder = thread && thread.replyClaimOpenid;
  const claimedAt = Number(thread && thread.replyClaimAt);
  if (!holder || !Number.isFinite(claimedAt) || now - claimedAt >= CLAIM_WINDOW_MS) {
    return 'none';
  }
  if (holder === openid) {
    return 'mine';
  }
  return 'other';
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
    anchor: '',
    loading: true,
    submitting: false,
    viewerOpenid: '',
    claimState: '',
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
    return this.refreshTicket();
  },
  refreshTicket() {
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
        side: bubbleSide(item.role),
      }),
    );
    const viewerOpenid = result.viewerOpenid || this.data.viewerOpenid || '';
    const last = messages[messages.length - 1];
    this.setData({
      thread: mapThread(result.thread),
      viewerOpenid,
      claimState: claimState(result.thread, viewerOpenid, Date.now()),
      messages,
      anchor: last ? 'm' + last._id : '',
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
    if (this.data.claimState !== 'mine') {
      wx.showToast({
        title: this.data.claimState === 'other' ? '已有同事正在处理' : '需要先接手',
        icon: 'none',
      });
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
  claim() {
    if (this.data.submitting) {
      return;
    }
    this.setData({ submitting: true });
    return ticketingAdmin({
      action: 'csClaimReply',
      threadId: this.data.threadId,
    })
      .then(() => this.refreshTicket())
      .catch((err) => {
        this.setData({ submitting: false });
        if (err && err.code === 'CLAIMED') {
          wx.showToast({ title: '已有同事正在处理', icon: 'none' });
          return;
        }
        this.showError(err);
      });
  },
  release() {
    if (this.data.submitting) {
      return;
    }
    this.setData({ submitting: true });
    return ticketingAdmin({
      action: 'csReleaseReply',
      threadId: this.data.threadId,
    })
      .then(() => this.refreshTicket())
      .catch(() => {
        this.setData({ submitting: false });
        wx.showToast({ title: '放开失败', icon: 'none' });
      });
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

module.exports = { claimState };
