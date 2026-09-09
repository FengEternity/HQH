const INIT_KEY = 'hqh_db_inited_v1';

App({
  onLaunch() {
    if (!wx.cloud) {
      return;
    }
    wx.cloud.init({
      env: wx.cloud.DYNAMIC_CURRENT_ENV,
      traceUser: true,
    });
    // 集合已建好后不必每次冷启动再跑 5 次 createCollection，否则首页会被拖住
    if (wx.getStorageSync(INIT_KEY)) {
      return;
    }
    wx.cloud
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
