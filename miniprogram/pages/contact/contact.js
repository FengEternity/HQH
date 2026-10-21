const { ticketing } = require('../../utils/api');
const { contact } = require('../../config.js');
const { readLabel } = require('../../utils/readReceipt');

const STORE_ACCOUNT = 'hqh_support_account';

function contactCfg() {
  return contact || {};
}

function faqs() {
  return (contactCfg().faqs || []).slice();
}

function findFaq(id) {
  return faqs().find((item) => item.id === id);
}

function quickFaqs() {
  return faqs().filter((item) => item.id !== 'human');
}

function makeAccount() {
  const n = Math.floor(1000 + Math.random() * 9000);
  return 'YD' + Date.now().toString().slice(-6) + n;
}

function mapMessage(message, thread, messages) {
  const meta = message.meta || {};
  const label = readLabel(message, thread, 'user', messages);
  return Object.assign({}, message, {
    account: meta.account,
    actions: meta.actions,
    readLabel: label,
    readState: label === '已读' ? 'read' : label === '未读' ? 'unread' : '',
  });
}

Page({
  data: {
    hours: '',
    faqs: [],
    thread: null,
    messages: [],
    draft: '',
    anchor: '',
    nickname: '',
  },
  onLoad() {
    const cfg = contactCfg();
    this.setData({
      hours: cfg.hours || '工作日 9:00–18:00',
      faqs: quickFaqs(),
    });
  },
  onShow() {
    this.armSeenRefresh();
    return this.loadHistory();
  },
  onHide() {
    this.disarmSeenRefresh();
  },
  onUnload() {
    this.disarmSeenRefresh();
  },
  loadHistory() {
    return ticketing({ action: 'csHistory' })
      .then((result) => this.applyResult(result))
      .catch((err) => this.showError(err));
  },
  armSeenRefresh() {
    this.disarmSeenRefresh();
    const timer = setInterval(() => {
      ticketing({ action: 'csHistory' })
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
  applyResult(result, doneLocalId) {
    const raw = result.messages || [];
    const server = raw.map((item) => mapMessage(item, result.thread, raw));
    const pending = (this.data.messages || []).filter(
      (item) => item.local && item._id !== doneLocalId,
    );
    const messages = server.concat(pending);
    const last = messages[messages.length - 1];
    const next = {
      thread: result.thread,
      messages,
      hours: contactCfg().hours || '工作日 9:00–18:00',
      anchor: last ? 'm' + last._id : '',
    };
    if (typeof result.nickname === 'string' && (result.nickname || !this.data.nickname)) {
      next.nickname = result.nickname;
    }
    this.setData(next);
  },
  onProfileBound(e) {
    const nickname = e && e.detail && e.detail.nickname;
    if (nickname) {
      this.setData({ nickname });
    }
  },
  ensureProfile() {
    if (String(this.data.nickname || '').trim()) {
      return true;
    }
    wx.showToast({ title: '请先填写昵称', icon: 'none' });
    return false;
  },
  pushLocal(text) {
    const message = mapMessage({
      _id: 'local-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      role: 'user',
      text,
      local: true,
      failed: false,
    }, this.data.thread);
    const messages = (this.data.messages || []).concat(message);
    this.setData({
      messages,
      draft: '',
      anchor: 'm' + message._id,
    });
    return message._id;
  },
  markFailed(localId) {
    if (!localId) {
      return;
    }
    const messages = (this.data.messages || []).map((item) =>
      item._id === localId ? Object.assign({}, item, { failed: true }) : item,
    );
    this.setData({ messages });
  },
  showError(err) {
    wx.showToast({ title: err.message || '请求失败', icon: 'none' });
  },
  withThread(data) {
    const threadId = this.data.thread && this.data.thread._id;
    return threadId ? Object.assign({}, data, { threadId }) : data;
  },
  submit(data, localId) {
    return ticketing(this.withThread(data))
      .then((result) => {
        this.applyResult(result, localId);
        return true;
      })
      .catch((err) => {
        this.markFailed(localId);
        this.showError(err);
        return false;
      });
  },
  requestReplySubscription() {
    const tmplId = contactCfg().replyTplId;
    if (!tmplId) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      try {
        const request = wx.requestSubscribeMessage({
          tmplIds: [tmplId],
          success: done,
          fail: done,
        });
        if (request && typeof request.then === 'function') {
          request.then(done, done);
        }
      } catch (err) {
        done();
      }
    });
  },
  onDraft(e) {
    this.setData({ draft: e.detail.value });
  },
  fillQuick(e) {
    const faq = findFaq(e.currentTarget.dataset.id);
    if (!faq) {
      return;
    }
    this.setData({ draft: faq.title });
  },
  askFaq(e) {
    const faq = findFaq(e.currentTarget.dataset.id);
    if (!faq || !this.ensureProfile()) {
      return;
    }
    if (faq.id === 'claim') {
      return this.claimAccount();
    }
    const sendFaq = () =>
      this.submit({
        action: 'csSend',
        text: faq.title,
        faqId: faq.id,
      });
    if (faq.id === 'missing' || faq.id === 'human') {
      return this.requestReplySubscription().then(sendFaq);
    }
    return sendFaq();
  },
  onAction(e) {
    const id = e.currentTarget.dataset.id;
    if (id === 'claim') {
      this.claimAccount();
      return;
    }
    if (id === 'copyAccount') {
      this.copyAccount();
      return;
    }
    const faq = findFaq(id);
    if (faq) {
      return this.askFaq({ currentTarget: { dataset: { id } } });
    }
  },
  send() {
    const text = (this.data.draft || '').trim();
    if (!text || !this.ensureProfile()) {
      return;
    }
    const localId = this.pushLocal(text);
    return this.requestReplySubscription().then(() =>
      this.submit(
        {
          action: 'csSend',
          text,
        },
        localId,
      ),
    );
  },
  retrySend(e) {
    const localId = e.currentTarget.dataset.id;
    const message = (this.data.messages || []).find((item) => item._id === localId);
    if (!message || !message.failed || !this.ensureProfile()) {
      return;
    }
    this.setData({
      messages: this.data.messages.map((item) =>
        item._id === localId ? Object.assign({}, item, { failed: false }) : item,
      ),
      anchor: 'm' + localId,
    });
    return this.requestReplySubscription().then(() =>
      this.submit(
        {
          action: 'csSend',
          text: message.text,
        },
        localId,
      ),
    );
  },
  claimAccount() {
    if (!this.ensureProfile()) {
      return;
    }
    let account = wx.getStorageSync(STORE_ACCOUNT);
    if (!account) {
      account = makeAccount();
      wx.setStorageSync(STORE_ACCOUNT, account);
    }
    return this.submit({
      action: 'csSend',
      text: '领取账号',
      faqId: 'claim',
      account,
    });
  },
  copyAccount() {
    let account = wx.getStorageSync(STORE_ACCOUNT);
    if (!account) {
      const message = this.data.messages
        .slice()
        .reverse()
        .find((item) => item.account);
      account = message && message.account;
    }
    if (!account) {
      return;
    }
    wx.setClipboardData({
      data: account,
      success: () => wx.showToast({ title: '账号已复制', icon: 'none' }),
    });
  },
});
