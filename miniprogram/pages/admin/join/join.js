const { admin } = require('../../../utils/api');

const ERROR_MESSAGES = {
  INVALID_INVITE: '邀请无效',
  ALREADY_STAFF: '你已在名单中',
  STAFF_DISABLED: '需要管理员重新启用',
};

Page({
  data: {
    loading: true,
    result: '',
  },
  onLoad(query) {
    if (this.inviteConsumed) return Promise.resolve();
    this.inviteConsumed = true;
    const code = query && query.invite;
    if (!code) {
      this.setData({ loading: false, result: '邀请无效' });
      return Promise.resolve();
    }
    return admin({ action: 'adminClaimInvite', code })
      .then(() => {
        this.setData({ loading: false, result: '领取成功' });
        wx.redirectTo({ url: '/pages/admin/home/home' });
      })
      .catch((error) => {
        this.setData({
          loading: false,
          result: ERROR_MESSAGES[error && error.code] || '邀请无效',
        });
      });
  },
});
