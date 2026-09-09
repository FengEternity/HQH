const { catalog } = require('../../utils/api');
const { withPosterUrl } = require('../../utils/videoMedia');

Page({
  data: {
    video: null,
    src: '',
    error: '',
  },
  onLoad(query) {
    const id = query.id;
    catalog({ action: 'getVideo', id })
      .then((res) => {
        const video = withPosterUrl(res.video);
        if (video && video.title) {
          wx.setNavigationBarTitle({ title: video.title });
        }
        const src = String((res && res.videoUrl) || '').trim();
        if (!src) {
          this.setData({
            video,
            error:
              video && video.videoFileId
                ? '视频地址未返回。请重新上传部署 catalog 云函数后再试'
                : '暂无视频文件',
          });
          return;
        }
        const posterUrl = String((video && video.posterUrl) || '').trim();
        this.setData({
          video: posterUrl ? Object.assign({}, video, { posterUrl }) : video,
          src,
        });
      })
      .catch((err) => {
        this.setData({ error: err.message || '无法播放' });
      });
  },
  onVideoError() {
    this.setData({
      error: '视频无法播放，请确认已上传云存储文件。',
    });
  },
});
