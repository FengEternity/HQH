const { catalog } = require('../../utils/api');
const { contact } = require('../../config.js');

const STORE_ACCOUNT = 'hqh_support_account';
const FALLBACK_WELCOME = '如您需求的问题没有解决，请联系我完善问题库，并领取账号。';

function contactCfg() {
  return contact || {};
}

function faqs() {
  return (contactCfg().faqs || []).slice();
}

function findFaq(id) {
  return faqs().find((item) => item.id === id);
}

function matchFaq(text) {
  const q = String(text || '').trim();
  if (!q) {
    return null;
  }
  if (/账号|领取/.test(q)) {
    return findFaq('claim') || null;
  }
  if (/没有|缺|找不到|完善|问题库/.test(q)) {
    return findFaq('missing') || null;
  }
  if (/怎么找|搜索|视频/.test(q)) {
    return findFaq('howto') || null;
  }
  if (/人工|微信|电话|联系/.test(q)) {
    return findFaq('human') || null;
  }
  return null;
}

function makeAccount() {
  const n = Math.floor(1000 + Math.random() * 9000);
  return 'YD' + Date.now().toString().slice(-6) + n;
}

Page({
  data: {
    hours: '',
    faqs: [],
    messages: [],
    draft: '',
    anchor: '',
  },
  seq: 0,
  onLoad() {
    const cfg = contactCfg();
    const hours = cfg.hours || '工作日 9:00–18:00';
    const welcome = cfg.welcome || FALLBACK_WELCOME;
    this.seq = 0;
    this.setData({ hours, faqs: faqs() });
    this.pushStaff(welcome, {
      actions: [
        { id: 'claim', label: '领取账号' },
        { id: 'missing', label: '没有我要的讲解' },
        { id: 'howto', label: '怎么找视频' },
      ],
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
    this.appendUser(faq.title);
    if (faq.id === 'missing' || faq.id === 'human') {
      this.submitInbox(faq.title, 'faq');
    }
    this.replyFaq(faq);
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
    if (id === 'copyWechat') {
      this.copyWechat();
      return;
    }
    if (id === 'callPhone') {
      this.callPhone();
      return;
    }
    const faq = findFaq(id);
    if (faq) {
      this.appendUser(faq.title);
      if (faq.id === 'missing' || faq.id === 'human') {
        this.submitInbox(faq.title, 'faq');
      }
      this.replyFaq(faq);
    }
  },
  send() {
    const text = (this.data.draft || '').trim();
    if (!text) {
      return;
    }
    this.setData({ draft: '' });
    this.appendUser(text);
    this.submitInbox(text, 'typed');
    const faq = matchFaq(text);
    if (faq) {
      this.replyFaq(faq);
      return;
    }
    this.pushStaff(
      '已记下并送到运营后台。把品牌、型号和卡在哪一步写清楚，补进问题库后这条讲解会出现在对应合集。需要账号的话点「领取账号」。',
      {
        actions: [
          { id: 'claim', label: '领取账号' },
          { id: 'human', label: '转人工' },
        ],
      },
    );
  },
  replyFaq(faq) {
    if (faq.id === 'claim') {
      this.pushStaff(faq.answer, {
        actions: [{ id: 'claim', label: '领取账号' }],
      });
      return;
    }
    if (faq.id === 'human') {
      this.pushHuman(faq.answer);
      return;
    }
    this.pushStaff(faq.answer);
  },
  claimAccount() {
    let account = wx.getStorageSync(STORE_ACCOUNT);
    if (!account) {
      account = makeAccount();
      wx.setStorageSync(STORE_ACCOUNT, account);
    }
    this.appendUser('领取账号');
    this.pushStaff('这是你的资料馆账号，点复制带走。回来搜型号、补充问题时把账号一并告诉我。', {
      account,
      actions: [{ id: 'copyAccount', label: '复制账号' }],
    });
  },
  copyAccount() {
    const account = wx.getStorageSync(STORE_ACCOUNT);
    if (!account) {
      return;
    }
    wx.setClipboardData({
      data: account,
      success: () => wx.showToast({ title: '账号已复制', icon: 'none' }),
    });
  },
  copyWechat() {
    const wechatId = contactCfg().wechatId;
    if (!wechatId) {
      wx.showToast({ title: '还没配置客服微信', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: wechatId,
      success: () => wx.showToast({ title: '微信号已复制', icon: 'none' }),
    });
  },
  callPhone() {
    const phone = contactCfg().phone;
    if (!phone) {
      wx.showToast({ title: '还没配置客服电话', icon: 'none' });
      return;
    }
    wx.makePhoneCall({ phoneNumber: String(phone), fail: () => {} });
  },
  submitInbox(text, kind) {
    const account = wx.getStorageSync(STORE_ACCOUNT) || '';
    catalog({ action: 'submitSupport', text, account, kind: kind || 'typed' }).catch((err) => {
      wx.showToast({ title: err.message || '留言没送出去', icon: 'none' });
    });
  },
  appendUser(text) {
    this.pushMessage({ role: 'user', text });
  },
  pushStaff(text, extra) {
    this.pushMessage(Object.assign({ role: 'staff', text }, extra || {}));
  },
  pushHuman(text) {
    const cfg = contactCfg();
    const actions = [];
    if (cfg.wechatId) {
      actions.push({ id: 'copyWechat', label: '复制微信' });
    }
    if (cfg.phone) {
      actions.push({ id: 'callPhone', label: '拨打电话' });
    }
    let body = text;
    if (cfg.wechatId) {
      body += '\n客服微信：' + cfg.wechatId;
    }
    if (cfg.phone) {
      body += '\n客服电话：' + cfg.phone;
    }
    if (!cfg.wechatId && !cfg.phone) {
      body += '\n人工联系方式还没填，可先把问题发在对话框里。';
    }
    this.pushStaff(body, { actions: actions.length ? actions : undefined });
  },
  pushMessage(msg) {
    this.seq += 1;
    const id = this.seq;
    const row = Object.assign({ id }, msg);
    const messages = this.data.messages.concat([row]);
    this.setData({
      messages,
      anchor: 'm' + id,
    });
  },
});
