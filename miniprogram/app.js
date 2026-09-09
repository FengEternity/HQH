const INIT_KEY = 'hqh_db_inited_v1';

App({
  globalData: {
    cloudReady: null,
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
