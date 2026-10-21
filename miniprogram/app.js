const { applyDefaultShare } = require('./utils/defaultShare');

// 微信没有全站分享开关。页面脚本在 app.js 之后执行，这里接住 Page，
// 给每个页面补上转发和朋友圈回调，右上角菜单才会出现分享。
const nativePage = Page;
Page = function pageWithDefaultShare(config) {
  return nativePage(applyDefaultShare(config));
};

const INIT_KEY = 'hqh_db_inited_v2';

App({
  globalData: {
    cloudReady: null,
    nickname: '',
    avatarFileId: '',
  },
  onLaunch() {
    if (!wx.cloud) {
      this.globalData.cloudReady = Promise.resolve();
      return;
    }
    wx.cloud.init({
      env: wx.cloud.DYNAMIC_CURRENT_ENV,
      traceUser: true,
    });
    // 集合已建好后不必每次冷启动再跑 createCollection。
    // 首次未建库时串行 initDb，再让首页 listHome，避免和首屏抢同一云函数并发槽。
    if (wx.getStorageSync(INIT_KEY)) {
      this.globalData.cloudReady = Promise.resolve();
      return;
    }
    this.globalData.cloudReady = wx.cloud
      .callFunction({
        name: 'catalog',
        data: { action: 'initDb' },
      })
      .then((res) => {
        if (res && res.result && res.result.ok) {
          wx.setStorageSync(INIT_KEY, 1);
        }
      })
      .catch((err) => {
        console.error('initDb failed', err);
      });
  },
});
