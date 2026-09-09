const { catalog, isMockMode } = require('../../utils/api');

const LOCAL_MEDIA = 'http://127.0.0.1:8787/media/';

Page({
  data: {
    video: null,
    src: '',
    error: '',
    startSec: 0,
  },
  onLoad(query) {
    const id = query.id;
    const startSec = Math.max(0, Number(query.t) || 0);
    this.setData({ startSec });
    catalog({ action: 'getVideo', id })
      .then((res) => {
        const video = res.video;
        this.setData({ video });
        if (video && video.title) {
          wx.setNavigationBarTitle({ title: video.title });
        }
        return this.resolveSrc(video);
      })
      .then((src) => {
        if (!src) {
          return;
        }
        this.setData({ src });
      })
      .catch((err) => {
        this.setData({ error: err.message || '无法播放' });
      });
  },
  resolveSrc(video) {
    const fileId = (video && video.videoFileId) || '';
    if (fileId.indexOf('cloud://') === 0) {
      return wx.cloud.getTempFileURL({ fileList: [fileId] }).then((fileRes) => {
        const row = fileRes && fileRes.fileList && fileRes.fileList[0];
        return (row && row.tempFileURL) || '';
      });
    }
    if (video && video.localFile && isMockMode()) {
      return Promise.resolve(LOCAL_MEDIA + encodeURIComponent(video.localFile));
    }
    return Promise.resolve('');
  },
  onVideoError() {
    this.setData({
      error: '播不了。请先运行 node scripts/preview-server.js，并在开发者工具关闭「校验合法域名」。',
    });
  },
});
