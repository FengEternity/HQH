const { ticketing } = require('../../utils/api');
const { contact } = require('../../config.js');

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

// 输入框旁常驻「转人工」，快捷区不再重复一颗
function quickFaqs() {
  return faqs().filter((item) => item.id !== 'human');
}

function makeAccount() {
  const n = Math.floor(1000 + Math.random() * 9000);
  return 'YD' + Date.now().toString().slice(-6) + n;
}

function mapMessage(message) {
  const meta = message.meta || {};
  return Object.assign({}, message, {
    account: meta.account,
    actions: meta.actions,
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
  },
  onLoad() {
    const cfg = contactCfg();
    this.setData({
      hours: cfg.hours || '工作日 9:00–18:00',
      faqs: quickFaqs(),
    });
  },
  onShow() {
    return ticketing({ action: 'csHistory' })
      .then((result) => this.applyResult(result))
      .catch((err) => this.showError(err));
  },
  applyResult(result, doneLocalId) {
    const server = (result.messages || []).map(mapMessage);
    const pending = (this.data.messages || []).filter(
      (item) => item.local && item._id !== doneLocalId,
    );
    const messages = server.concat(pending);
    const last = messages[messages.length - 1];
    this.setData({
      thread: result.thread,
      messages,
      hours: contactCfg().hours || '工作日 9:00–18:00',
      anchor: last ? 'm' + last._id : '',
    });
  },
  pushLocal(text) {
    const message = {
      _id: 'local-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      role: 'user',
      text,
      local: true,
      failed: false,
    };
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
  askFaq(e) {
    const faq = findFaq(e.currentTarget.dataset.id);
    if (!faq) {
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
    if (!text) {
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
    if (!message || !message.failed) {
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
  escalate() {
    const text = (this.data.draft || '').trim();
    const data = { action: 'csEscalate' };
    if (text) {
      data.text = text;
      this.setData({ draft: '' });
    }
    return this.requestReplySubscription().then(() => this.submit(data));
  },
  claimAccount() {
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
