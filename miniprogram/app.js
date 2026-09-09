const { useLocalCatalog } = require('./config');

App({
  onLaunch() {
    if (useLocalCatalog || !wx.cloud) {
      return;
    }
    let appId = '';
    try {
      appId = wx.getAccountInfoSync().miniProgram.appId;
    } catch (error) {
      appId = '';
    }
    if (!appId || appId === 'touristappid') {
      return;
    }
    wx.cloud.init({
      env: wx.cloud.DYNAMIC_CURRENT_ENV,
      traceUser: true,
    });
  },
});
