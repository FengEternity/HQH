const { ticketingAdmin } = require('../../../utils/api');
const { cachedThread, rememberThread } = require('../csViewCache');
const { readLabel } = require('../../../utils/readReceipt');

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

function conversationLabel(status, messages) {
  if (status === 'closed') {
    return '已关闭';
  }
  const last = (messages || [])
    .slice()
    .reverse()
    .find((item) => item.role === 'user' || item.role === 'operator');
  if (!last) {
    return '';
  }
  return last.role === 'user' ? '未读' : '已回复';
}

function userLabel(thread) {
  const name = thread && String(thread.nickname || '').trim();
  if (name) {
    return name;
  }
  const openid = thread && thread.openid;
  return openid ? '用户 ' + openid.slice(-8) : '未知用户';
}

const HOLD_MS = 600000;

function holdState(thread, openid, now) {
  const holder = thread && thread.replyClaimOpenid;
  const heldAt = Number(thread && thread.replyClaimAt);
  if (!holder || !Number.isFinite(heldAt) || now - heldAt >= HOLD_MS) {
    return 'free';
  }
  if (holder === openid) {
    return 'mine';
  }
  return 'other';
}

function mapThread(thread, messages) {
  return Object.assign({}, thread, {
    conversationLabel: conversationLabel(thread.status, messages),
    userLabel: userLabel(thread),
  });
}

function presentMessage(item, thread, messages) {
  const label = readLabel(item, thread, 'operator', messages);
  return Object.assign({}, item, {
    roleLabel: roleLabel(item.role),
    timeLabel: formatTime(item.createdAt),
    side: bubbleSide(item.role),
    readLabel: label,
    readState: label === '已读' ? 'read' : label === '未读' ? 'unread' : '',
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
    holdState: 'free',
  },
  onLoad(options) {
    this.setData({ threadId: options.id || '' });
  },
  onShow() {
    if (this.data.threadId) {
      this.armSeenRefresh();
      return this.load();
    }
    this.setData({ loading: false });
  },
  onHide() {
    this.disarmSeenRefresh();
  },
  onUnload() {
    this.disarmSeenRefresh();
  },
  armSeenRefresh() {
    this.disarmSeenRefresh();
    const timer = setInterval(() => {
      if (!this.data.threadId) {
        return;
      }
      ticketingAdmin({
        action: 'csAdminGet',
        threadId: this.data.threadId,
      })
        .then((result) => this.applyResult(result))
        .catch(() => {});
    }, 4000);
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
    this._seenTimer = timer;
  },
  disarmSeenRefresh() {
    if (this._seenTimer) {
      clearInterval(this._seenTimer);
      this._seenTimer = null;
    }
  },
  load() {
    const cached = cachedThread(this.data.threadId);
    if (cached) {
      this.applyResult(cached);
    } else if (!this.data.thread) {
      this.setData({ loading: true });
    }
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
  applyResult(result, doneLocalId) {
    const thread = result.thread;
    const raw = result.messages || [];
    const server = raw.map((item) => presentMessage(item, thread, raw));
    const pending = (this.data.messages || []).filter(
      (item) => item.local && item._id !== doneLocalId,
    );
    const messages = server.concat(pending);
    const last = messages[messages.length - 1];
    const viewerOpenid = result.viewerOpenid || this.data.viewerOpenid || '';
    this.setData({
      thread: mapThread(thread, messages),
      viewerOpenid,
      holdState: holdState(thread, viewerOpenid, Date.now()),
      messages,
      anchor: last ? 'm' + last._id : '',
      loading: false,
      submitting: false,
    });
    const threadId = (thread && thread._id) || this.data.threadId;
    rememberThread(threadId, result);
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
    if (!text || this.data.submitting || !this.data.thread || this.data.thread.status === 'closed') {
      return;
    }
    if (this.data.holdState !== 'mine') {
      wx.showToast({
        title: this.data.holdState === 'other' ? '同事正在回复' : '请先持有会话',
        icon: 'none',
      });
      return;
    }
    const localId = 'local-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const local = presentMessage(
      {
        _id: localId,
        role: 'operator',
        text,
        local: true,
        failed: false,
      },
      this.data.thread,
    );
    this.setData({
      messages: (this.data.messages || []).concat(local),
      draft: '',
      anchor: 'm' + localId,
    });
    return ticketingAdmin({
      action: 'csAdminReply',
      threadId: this.data.threadId,
      text,
    })
      .then((result) => this.applyResult(result, localId))
      .catch((err) => this.failReply(err, localId, text));
  },
  retryReply(e) {
    const localId = e.currentTarget.dataset.id;
    const message = (this.data.messages || []).find((item) => item._id === localId);
    if (!message || !message.failed) {
      return;
    }
    this.setData({
      messages: this.data.messages.map((item) =>
        item._id === localId ? Object.assign({}, item, { failed: false }) : item,
      ),
    });
    return ticketingAdmin({
      action: 'csAdminReply',
      threadId: this.data.threadId,
      text: message.text,
    })
      .then((result) => this.applyResult(result, localId))
      .catch((err) => this.failReply(err, localId, message.text));
  },
  failReply(err, localId, text) {
    if (err && (err.code === 'CLAIMED' || err.code === 'CLAIM_REQUIRED')) {
      this.setData({
        messages: (this.data.messages || []).filter((item) => item._id !== localId),
        draft: this.data.draft || text,
        holdState: err.code === 'CLAIMED' ? 'other' : 'free',
      });
      wx.showToast({ title: err.code === 'CLAIMED' ? '同事正在回复' : '请先持有会话', icon: 'none' });
      return this.refreshTicket();
    }
    this.markFailed(localId);
    return this.showError(err);
  },
  markFailed(localId) {
    this.setData({
      messages: (this.data.messages || []).map((item) =>
        item._id === localId ? Object.assign({}, item, { failed: true }) : item,
      ),
    });
  },
  claim() {
    if (this.data.submitting || !this.data.thread || this.data.thread.status === 'closed') {
      return;
    }
    if (this.data.holdState === 'mine') {
      return;
    }
    if (this.data.holdState === 'other') {
      wx.showToast({ title: '同事正在回复', icon: 'none' });
      return this.refreshTicket();
    }
    this.setData({ submitting: true });
    return ticketingAdmin({
      action: 'csClaimReply',
      threadId: this.data.threadId,
    })
      .then(() => this.refreshTicket())
      .catch((err) => {
        if (err && (err.code === 'CLAIMED' || err.code === 'CLAIM_REQUIRED')) {
          wx.showToast({ title: '同事正在回复', icon: 'none' });
          return this.refreshTicket();
        }
        return this.showError(err);
      });
  },
  release() {
    if (this.data.submitting || this.data.holdState !== 'mine') {
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
});

module.exports = { conversationLabel, holdState, userLabel };
