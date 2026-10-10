const { admin } = require('../../../utils/api');

Page({
  data: {
    progressText: '正在读取转码进度',
    progressItems: [],
  },
  onShow() {
    this.loadProgress();
  },
  onHide() {
    this.stopProgressPoll();
  },
  onUnload() {
    this.stopProgressPoll();
  },
  stopProgressPoll() {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  },
  ensureProgressPoll() {
    if (this.progressTimer) {
      return;
    }
    this.progressTimer = setInterval(() => {
      this.loadProgress();
    }, 8000);
  },
  loadProgress() {
    return admin({ action: 'getIngestProgress' })
      .then((result) => {
        const running = result.running || 0;
        const queued = result.queued || 0;
        const failed = result.failed || 0;
        const progressText =
          running + queued + failed === 0
            ? '当前没有正在处理或失败的视频'
            : '正在转 ' + running + ' 条，排队 ' + queued + ' 条，失败 ' + failed + ' 条';
        this.setData({
          progressText,
          progressItems: result.items || [],
        });
        if (running + queued > 0) {
          this.ensureProgressPoll();
        } else {
          this.stopProgressPoll();
        }
      })
      .catch((err) => {
        if (err.code === 'UNAUTHORIZED') {
          wx.redirectTo({ url: '/pages/admin/login/login' });
        }
      });
  },
  requeuePlayback() {
    wx.showModal({
      title: '重新处理不合格视频',
      content: '把还没通过播放检查的已有视频放进转码队列。已上架的不会下架。',
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        wx.showLoading({ title: '唤醒中', mask: true });
        admin({ action: 'enqueueNoncompliantVideos' })
          .then((result) => {
            wx.hideLoading();
            let title = '已入队 ' + result.enqueued + ' 条';
            if (result.woke) {
              title = result.enqueued > 0 ? '已入队并已唤醒' : '已唤醒，开始处理';
            } else if (result.enqueued === 0) {
              title = '唤醒失败';
            }
            wx.showToast({
              title,
              icon: 'none',
            });
            this.loadProgress();
          })
          .catch((err) => {
            wx.hideLoading();
            if (err.code === 'UNAUTHORIZED') {
              wx.redirectTo({ url: '/pages/admin/login/login' });
              return;
            }
            wx.showToast({ title: err.message || '入队失败', icon: 'none' });
          });
      },
    });
  },
});
