const { admin } = require('../../../utils/api');
const { withPosterUrl, planVideoCoverUpload, cloudUploadOptions } = require('../../../utils/videoMedia');

function openCoverCrop(src) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    wx.navigateTo({
      url: `/pages/admin/cover-crop/cover-crop?src=${encodeURIComponent(src)}`,
      events: {
        done: (payload) => finish((payload && payload.path) || null),
        cancel: () => finish(null),
      },
      success: (result) => result.eventChannel.emit('init', { src }),
      fail: () => finish(null),
    });
  });
}

const PLACEHOLDER_INTRO = '讲解处理中，完成后请核对简介。';

function fileExt(filePath, fallback) {
  const match = String(filePath || '').match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
  return (match && match[1]) || fallback;
}

function formatLocalTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function deriveVideoUi(video) {
  const source = video && typeof video === 'object' ? video : {};
  const ingest = source.ingest;
  const src = ingest && typeof ingest === 'object' ? ingest : {};
  const phase = src.phase || 'idle';
  const asr = src.asr || 'pending';
  const introSource = src.introSource || 'placeholder';
  const ingestBusy = phase === 'queued' || phase === 'running';
  const processedFile = src.videoFileId === source.videoFileId;
  const playbackCompliant = source.media?.playback?.compliant === true;
  const canPublish = phase === 'ready' && processedFile && playbackCompliant;
  let ingestHint = '';

  if (phase === 'queued' || phase === 'running') {
    ingestHint = '等待视频处理';
  } else if (phase === 'failed') {
    ingestHint = '视频处理失败，请重试';
  } else if (phase !== 'ready' || !processedFile) {
    ingestHint = '等待视频处理';
  } else if (!playbackCompliant) {
    ingestHint = '视频未通过播放检查';
  } else if (phase === 'ready') {
    if (asr === 'failed') {
      ingestHint = '转写失败，播放文件已更新，请手写简介后再上架';
    } else if (asr === 'skipped') {
      ingestHint = '无音轨，已跳过转写';
    } else if (asr === 'ready' && introSource === 'placeholder') {
      ingestHint = '字幕已出，简介需手写';
    } else {
      ingestHint = '待核对后上架';
    }
  }

  const showRetryIngest = phase === 'failed' || phase === 'ready';
  const canRetryIngest = showRetryIngest && !ingestBusy;

  return {
    ingestPhase: phase,
    ingestHint,
    introSource,
    ingestBusy,
    showRetryIngest,
    canRetryIngest,
    canPublish,
  };
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
    ingestPhase: 'idle',
    ingestHint: '',
    introSource: 'placeholder',
    ingestBusy: false,
    showRetryIngest: false,
    canRetryIngest: false,
    canPublish: false,
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
    this.setData(
      Object.assign(
        {
          title: video.title,
          intro: video.intro,
          modelName: video.modelName,
          tags: (video.tags || []).join(','),
          coverFileId: video.coverFileId,
          videoFileId: video.videoFileId,
          posterUrl: video.posterUrl || '',
          brandId: video.brandId || brandId,
          id: video._id || this.data.id,
        },
        deriveVideoUi(video),
      ),
    );
  },
  reloadVideo() {
    if (!this.data.id) {
      return Promise.resolve();
    }
    return admin({ action: 'adminGetVideo', id: this.data.id }).then((payload) => {
      if (payload && payload.video) {
        this.applyVideo(payload.video, this.data.brandId);
      }
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
  applyUploadShell() {
    const patch = {};
    if (!String(this.data.title || '').trim()) {
      patch.title = `讲解${formatLocalTimestamp()}`;
    }
    if (!String(this.data.intro || '').trim()) {
      patch.intro = PLACEHOLDER_INTRO;
    }
    if (!Object.keys(patch).length) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      this.setData(patch, () => resolve(true));
    });
  },
  ensureSaved() {
    return this.applyUploadShell().then((patched) => {
      if (!this.data.id) {
        return this.persist(true);
      }
      if (patched) {
        return this.persist(true).then(() => this.data.id);
      }
      return this.data.id;
    });
  },
  pickCoverPhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: (res) => {
        const filePath = res.tempFiles[0].tempFilePath;
        openCoverCrop(filePath)
          .then((croppedPath) => {
            if (!croppedPath) {
              return null;
            }
            return this.ensureSaved()
              .then(() => this.uploadCloudFile('cover', croppedPath, 'jpg'))
              .then((fileID) => {
                this.setData({
                  coverFileId: fileID,
                  posterUrl: croppedPath,
                  coverHint: '',
                });
              });
          })
          .catch((err) => wx.showToast({ title: err.message || '封面失败', icon: 'none' }));
      },
    });
  },
  uploadCloudFile(kind, filePath, ext) {
    const cloudPath = `${kind}/${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;
    wx.showLoading({ title: '上传中' });
    return wx.cloud
      .uploadFile(cloudUploadOptions({ kind, cloudPath, filePath }))
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
              return this.persistUploadedVideo().then(() => 'video');
            }
            if (plan.action === 'missing_thumb') {
              return this.persistUploadedVideo().then(() => 'missing_thumb');
            }
            return openCoverCrop(plan.path).then((croppedPath) => {
              if (!croppedPath) {
                return this.persist(true).then(() => 'crop_cancelled');
              }
              return this.uploadCloudFile('cover', croppedPath, 'jpg').then((coverId) => {
                this.setData({
                  coverFileId: coverId,
                  posterUrl: croppedPath,
                  coverHint: '未选手动封面，已用视频首帧裁剪',
                });
                return this.persist(true).then(() => 'cover');
              });
            });
          })
          .then((kind) => this.reloadVideo().then(() => kind))
          .then((kind) => {
            if (kind === 'missing_thumb') {
              wx.showToast({ title: '未获取到视频缩略图，请手动选封面', icon: 'none' });
              return;
            }
            if (kind === 'crop_cancelled') {
              wx.showToast({ title: '视频已保存，请手动选择封面', icon: 'none' });
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
  retryIngest() {
    if (!this.data.canRetryIngest || !this.data.id) {
      return;
    }
    admin({ action: 'enqueueVideoIngest', id: this.data.id })
      .then(() => {
        wx.showToast({ title: '已重新排队' });
        return this.reloadVideo();
      })
      .catch((err) => wx.showToast({ title: err.message || '重试失败', icon: 'none' }));
  },
  save() {
    this.persist(false).catch((err) => {
      wx.showToast({ title: err.message || '保存失败', icon: 'none' });
    });
  },
  // 只有刚上传完视频的这一步可以声明换片；其它保存里表单上的 videoFileId 可能已经
  // 被 worker 的转码文件取代，回传旧值会白白清掉字幕并重排一次。
  persistUploadedVideo() {
    return this.persist(true, { replaceVideo: true });
  },
  persist(silent, options) {
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
      replaceVideo: Boolean(options && options.replaceVideo),
    }).then((res) => {
      this.setData({ id: res.id });
      if (!silent) {
        wx.showToast({ title: '已保存' });
      }
      return res.id;
    });
  },
});
