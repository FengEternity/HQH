const { admin, isMockMode, localAdmin } = require('../../../utils/api');

function formatTime(sec) {
  const n = Math.max(0, Number(sec) || 0);
  const m = Math.floor(n / 60);
  const s = Math.floor(n % 60);
  return m + ':' + String(s).padStart(2, '0');
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
    localFile: '',
    posterUrl: '',
    mediaSrc: '',
    duration: 1,
    coverTime: 0,
    coverTimeLabel: '0:00',
    mockMode: false,
    coverHint: '',
  },
  onLoad(query) {
    const brandId = query.brandId || '';
    const id = query.id || '';
    this.setData({ brandId, id, mockMode: isMockMode() });
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
    const duration = Number(found.durationSec) || 1;
    this.setData({
      title: found.title,
      intro: found.intro,
      modelName: found.modelName,
      tags: (found.tags || []).join(','),
      coverFileId: found.coverFileId,
      videoFileId: found.videoFileId,
      localFile: found.localFile || '',
      posterUrl: found.posterUrl || '',
      mediaSrc: found.mediaSrc || '',
      duration,
      coverTime: 0,
      coverTimeLabel: '0:00',
      brandId: found.brandId || brandId,
      id: found._id || this.data.id,
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
  onCoverMeta(e) {
    const duration = Number(e.detail.duration) || this.data.duration || 1;
    this.setData({ duration });
  },
  onScrub(e) {
    const coverTime = Number(e.detail.value) || 0;
    this.setData({ coverTime, coverTimeLabel: formatTime(coverTime) });
    wx.createVideoContext('coverVideo', this).seek(coverTime);
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
          .then((id) => {
            if (this.data.mockMode) {
              return this.saveLocalPhoto(id, filePath);
            }
            return this.uploadCloudFile('cover', filePath, 'jpg').then((fileID) => {
              this.setData({ coverFileId: fileID });
            });
          })
          .catch((err) => wx.showToast({ title: err.message || '封面失败', icon: 'none' }));
      },
    });
  },
  saveLocalPhoto(id, filePath) {
    wx.showLoading({ title: '保存封面' });
    return new Promise((resolve, reject) => {
      wx.getFileSystemManager().readFile({
        filePath,
        encoding: 'base64',
        success: resolve,
        fail: () => reject(new Error('读图片失败')),
      });
    })
      .then((file) => localAdmin('/api/admin/cover-photo', { id, image: file.data }))
      .then((out) => {
        wx.hideLoading();
        if (!out.ok) {
          throw new Error(out.message || '封面保存失败');
        }
        this.setData({ posterUrl: out.posterUrl, coverHint: '' });
        wx.showToast({ title: '封面已更新' });
      })
      .catch((err) => {
        wx.hideLoading();
        throw err;
      });
  },
  pickCoverFrame() {
    this.ensureSaved()
      .then((id) => {
        if (!this.data.mockMode) {
          wx.showToast({ title: '云环境请用相册选封面', icon: 'none' });
          return null;
        }
        wx.showLoading({ title: '截取封面' });
        return localAdmin('/api/admin/cover-frame', { id, timeSec: this.data.coverTime }).then((out) => {
          wx.hideLoading();
          if (!out.ok) {
            throw new Error(out.message || '截帧失败');
          }
          this.setData({ posterUrl: out.posterUrl, coverHint: '' });
          wx.showToast({ title: '封面已更新' });
        });
      })
      .catch((err) => {
        wx.hideLoading();
        wx.showToast({ title: err.message || '截帧失败', icon: 'none' });
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
    if (this.data.mockMode) {
      wx.showToast({ title: '本地片源在「视频」文件夹里绑定', icon: 'none' });
      return;
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ['video'],
      success: (res) => {
        this.uploadCloudFile('video', res.tempFiles[0].tempFilePath, 'mp4')
          .then((fileID) => this.setData({ videoFileId: fileID }))
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
