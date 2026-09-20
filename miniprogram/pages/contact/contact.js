const { cs } = require('../../utils/api');
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
      faqs: faqs(),
    });
  },
  onShow() {
    return cs({ action: 'csHistory' })
      .then((result) => this.applyResult(result))
      .catch((err) => this.showError(err));
  },
  applyResult(result) {
    const messages = (result.messages || []).map(mapMessage);
    const last = messages[messages.length - 1];
    this.setData({
      thread: result.thread,
      messages,
      hours: contactCfg().hours || '工作日 9:00–18:00',
      anchor: last ? 'm' + last._id : '',
    });
  },
  showError(err) {
    wx.showToast({ title: err.message || '请求失败', icon: 'none' });
  },
  withThread(data) {
    const threadId = this.data.thread && this.data.thread._id;
    return threadId ? Object.assign({}, data, { threadId }) : data;
  },
  submit(data) {
    return cs(this.withThread(data))
      .then((result) => this.applyResult(result))
      .catch((err) => this.showError(err));
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
    this.setData({ draft: '' });
    return this.requestReplySubscription().then(() =>
      this.submit({
        action: 'csSend',
        text,
      }),
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
