const { admin } = require('../../../utils/api');
const { withPosterUrl, planVideoCoverUpload } = require('../../../utils/videoMedia');

function fileExt(filePath, fallback) {
  const match = String(filePath || '').match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
  return (match && match[1]) || fallback;
}

Page({
  data: {
    id: '',
    brandId: '',
    brandName: '',
    title: '',
    intro: '',
    modelName: '',
    tags: '',
    coverFileId: '',
    videoFileId: '',
    posterUrl: '',
    coverHint: '',
  },
  onLoad(query) {
    const brandId = query.brandId || '';
    const id = query.id || '';
    this.setData({ brandId, id });
    admin({ action: 'adminListBrands' })
      .then((res) => {
        const brand = (res.brands || []).find((item) => item._id === brandId);
        this.setData({ brandName: brand ? brand.name : '' });
        if (!id) {
          return null;
        }
        return admin({ action: 'adminGetVideo', id });
      })
      .then((payload) => {
        if (!payload || !payload.video) {
          return;
        }
        this.applyVideo(payload.video, brandId);
      })
      .catch((err) => wx.showToast({ title: err.message || '加载失败', icon: 'none' }));
  },
  applyVideo(found, brandId) {
    const video = withPosterUrl(found);
    this.setData({
      title: video.title,
      intro: video.intro,
      modelName: video.modelName,
      tags: (video.tags || []).join(','),
      coverFileId: video.coverFileId,
      videoFileId: video.videoFileId,
      posterUrl: video.posterUrl || '',
      brandId: video.brandId || brandId,
      id: video._id || this.data.id,
    });
  },
  onTitle(e) {
    this.setData({ title: e.detail.value });
  },
  onIntro(e) {
    this.setData({ intro: e.detail.value });
  },
  onModel(e) {
    this.setData({ modelName: e.detail.value });
  },
  onTags(e) {
    this.setData({ tags: e.detail.value });
  },
  ensureSaved() {
    if (this.data.id) {
      return Promise.resolve(this.data.id);
    }
    return this.persist(true);
  },
  pickCoverPhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: (res) => {
        const filePath = res.tempFiles[0].tempFilePath;
        this.ensureSaved()
          .then(() => this.uploadCloudFile('cover', filePath, 'jpg'))
          .then((fileID) => {
            this.setData({ coverFileId: fileID, posterUrl: filePath, coverHint: '' });
          })
          .catch((err) => wx.showToast({ title: err.message || '封面失败', icon: 'none' }));
      },
    });
  },
  uploadCloudFile(kind, filePath, ext) {
    const cloudPath = `${kind}/${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;
    wx.showLoading({ title: '上传中' });
    return wx.cloud
      .uploadFile({ cloudPath, filePath })
      .then((up) => {
        wx.hideLoading();
        return up.fileID;
      })
      .catch(() => {
        wx.hideLoading();
        throw new Error('上传失败');
      });
  },
  uploadVideo() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['video'],
      success: (res) => {
        const file = res.tempFiles[0];
        const plan = planVideoCoverUpload({
          coverFileId: this.data.coverFileId,
          thumbTempFilePath: file.thumbTempFilePath,
        });
        this.ensureSaved()
          .then(() => this.uploadCloudFile('video', file.tempFilePath, 'mp4'))
          .then((fileID) => {
            this.setData({ videoFileId: fileID });
            if (plan.action === 'keep') {
              return this.persist(true).then(() => 'video');
            }
            if (plan.action === 'missing_thumb') {
              return this.persist(true).then(() => 'missing_thumb');
            }
            return this.uploadCloudFile('cover', plan.path, fileExt(plan.path, 'jpg')).then((coverId) => {
              this.setData({
                coverFileId: coverId,
                posterUrl: plan.path,
                coverHint: '未选手动封面，已用视频首帧缩略图',
              });
              return this.persist(true).then(() => 'cover');
            });
          })
          .then((kind) => {
            if (kind === 'missing_thumb') {
              wx.showToast({ title: '未获取到视频缩略图，请手动选封面', icon: 'none' });
              return;
            }
            if (kind === 'cover') {
              wx.showToast({ title: '视频与封面已保存' });
              return;
            }
            wx.showToast({ title: '视频已保存' });
          })
          .catch((err) => wx.showToast({ title: err.message || '上传失败', icon: 'none' }));
      },
    });
  },
  save() {
    this.persist(false).catch((err) => {
      wx.showToast({ title: err.message || '保存失败', icon: 'none' });
    });
  },
  persist(silent) {
    if (!this.data.brandId) {
      wx.showToast({ title: '缺少品牌', icon: 'none' });
      return Promise.reject(new Error('缺少品牌'));
    }
    return admin({
      action: 'upsertVideo',
      id: this.data.id || undefined,
      title: this.data.title,
      intro: this.data.intro,
      brandId: this.data.brandId,
      modelName: this.data.modelName,
      tags: this.data.tags,
      coverFileId: this.data.coverFileId,
      videoFileId: this.data.videoFileId,
    }).then((res) => {
      this.setData({ id: res.id });
      if (!silent) {
        wx.showToast({ title: '已保存' });
      }
      return res.id;
    });
  },
});
