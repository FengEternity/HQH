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
        this.setData({ video });
        if (video && video.title) {
          wx.setNavigationBarTitle({ title: video.title });
        }
        return Promise.all([
          this.resolveCloudUrl(video && video.videoFileId),
          this.resolveCloudUrl(video && video.posterUrl),
        ]);
      })
      .then(([src, posterUrl]) => {
        const patch = {};
        if (src) {
          patch.src = src;
        }
        if (posterUrl && this.data.video) {
          patch.video = Object.assign({}, this.data.video, { posterUrl });
        }
        if (Object.keys(patch).length) {
          this.setData(patch);
        }
      })
      .catch((err) => {
        this.setData({ error: err.message || '无法播放' });
      });
  },
  resolveCloudUrl(fileId) {
    const id = String(fileId || '');
    if (id.indexOf('cloud://') === 0) {
      return wx.cloud.getTempFileURL({ fileList: [id] }).then((fileRes) => {
        const row = fileRes && fileRes.fileList && fileRes.fileList[0];
        return (row && row.tempFileURL) || '';
      });
    }
    return Promise.resolve(id);
  },
  onVideoError() {
    this.setData({
      error: '视频无法播放，请确认已上传云存储文件。',
    });
  },
});
