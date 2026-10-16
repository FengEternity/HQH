const { admin } = require('../../../utils/api');
const { withPosterUrl, displayedPoster, planVideoCoverUpload, cloudUploadOptions } = require('../../../utils/videoMedia');
const { captureVideoPoster } = require('../../../utils/videoPoster');

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

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function withoutPlaceholder(value) {
  const text = cleanText(value);
  return text === PLACEHOLDER_INTRO ? '' : text;
}

function splitVideoCopies(video) {
  const source = video && typeof video === 'object' ? video : {};
  const ingest = source.ingest && typeof source.ingest === 'object' ? source.ingest : {};
  const introSource = ingest.introSource || 'placeholder';
  const hasTitleCopies = typeof source.humanTitle === 'string' || typeof source.autoTitle === 'string';
  const hasIntroCopies = typeof source.humanIntro === 'string' || typeof source.autoIntro === 'string';
  const autoTitle = typeof source.autoTitle === 'string' ? source.autoTitle.trim() : '';
  const humanTitle = typeof source.humanTitle === 'string'
    ? source.humanTitle.trim()
    : (hasTitleCopies ? '' : cleanText(source.title));
  let autoIntro = '';
  let humanIntro = '';
  if (hasIntroCopies) {
    autoIntro = withoutPlaceholder(source.autoIntro);
    humanIntro = withoutPlaceholder(source.humanIntro);
  } else if (introSource === 'auto') {
    autoIntro = withoutPlaceholder(source.intro);
  } else {
    humanIntro = withoutPlaceholder(source.intro);
  }
  return { autoTitle, humanTitle, autoIntro, humanIntro };
}

function effectiveTitle(humanTitle, autoTitle) {
  return cleanText(humanTitle) || cleanText(autoTitle);
}

function effectiveIntro(humanIntro, autoIntro) {
  return cleanText(humanIntro) || cleanText(autoIntro) || PLACEHOLDER_INTRO;
}

function titleFromVideoFile(file) {
  const named = String((file && (file.name || file.fileName)) || '').trim();
  if (!named) {
    return '';
  }
  const base = named.split(/[/\\]/).pop();
  return base.replace(/\.[^.]+$/, '').trim();
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

  const autoIntro = typeof source.autoIntro === 'string' ? source.autoIntro.trim() : '';
  if ((phase === 'queued' || phase === 'running') && autoIntro && autoIntro !== PLACEHOLDER_INTRO) {
    ingestHint = '简介已出，播放文件仍在处理';
  } else if (phase === 'queued' || phase === 'running') {
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
      ingestHint = '自动简介未通过，请手写简介';
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
    autoTitle: '',
    humanTitle: '',
    autoIntro: '',
    humanIntro: '',
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
  applyVideo(found, brandId, options) {
    const video = withPosterUrl(found);
    const copies = splitVideoCopies(video);
    const keepEdits = Boolean(options && options.keepEdits);
    const poster = displayedPoster({
      currentCoverFileId: this.data.coverFileId,
      currentPosterUrl: this.data.posterUrl,
      nextCoverFileId: video.coverFileId,
      nextPosterUrl: video.posterUrl,
    });
    this.setData(
      Object.assign(
        keepEdits
          ? {
              autoTitle: copies.autoTitle,
              autoIntro: copies.autoIntro,
              humanTitle: this.data.humanTitle,
              humanIntro: this.data.humanIntro,
            }
          : copies,
        {
          modelName: keepEdits ? this.data.modelName : video.modelName,
          tags: keepEdits ? this.data.tags : (video.tags || []).join(','),
          coverFileId: poster.coverFileId,
          videoFileId: video.videoFileId,
          posterUrl: poster.posterUrl,
          brandId: video.brandId || brandId,
          id: video._id || this.data.id,
        },
        deriveVideoUi(video),
      ),
      () => this.watchIngest(),
    );
    if (poster.resolve) {
      this.resolveCoverPoster(poster.coverFileId);
    }
  },
  resolveCoverPoster(coverFileId) {
    if (!coverFileId || typeof wx === 'undefined' || !wx.cloud || !wx.cloud.getTempFileURL) {
      return;
    }
    wx.cloud.getTempFileURL({ fileList: [coverFileId] }).then((res) => {
      const row = res && res.fileList && res.fileList[0];
      const url = row && row.status === 0 ? String(row.tempFileURL || '').trim() : '';
      if (url && this.data.coverFileId === coverFileId) {
        this.setData({ posterUrl: url });
      }
    }).catch(() => {});
  },
  reloadVideo(keepEdits) {
    if (!this.data.id) {
      return Promise.resolve();
    }
    return admin({ action: 'adminGetVideo', id: this.data.id }).then((payload) => {
      if (payload && payload.video) {
        this.applyVideo(payload.video, this.data.brandId, { keepEdits: keepEdits === true });
      }
    });
  },
  onHumanTitle(e) {
    this.setData({ humanTitle: e.detail.value });
  },
  onHumanIntro(e) {
    this.setData({ humanIntro: e.detail.value });
  },
  onModel(e) {
    this.setData({ modelName: e.detail.value });
  },
  onTags(e) {
    this.setData({ tags: e.detail.value });
  },
  ensureSaved() {
    if (!this.data.id) {
      return this.persist(true);
    }
    return Promise.resolve(this.data.id);
  },
  pickCoverPhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['video'],
      sourceType: ['album'],
      success: (res) => {
        const picked = res.tempFiles && res.tempFiles[0];
        const filePath = picked && picked.thumbTempFilePath;
        if (!filePath) {
          wx.showToast({ title: '未获取到视频缩略图', icon: 'none' });
          return;
        }
        openCoverCrop(filePath)
          .then((croppedPath) => {
            if (!croppedPath) {
              return null;
            }
            return this.ensureSaved()
              .then(() => this.uploadCloudFile('cover', croppedPath, 'jpg'))
              .then((fileID) => new Promise((resolve, reject) => {
                this.setData({
                  coverFileId: fileID,
                  posterUrl: croppedPath,
                  coverHint: '',
                }, () => {
                  this.persist(true).then(resolve).catch(reject);
                });
              }));
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
  onShow() {
    this.watchIngest();
  },
  onHide() {
    this.stopWatchIngest();
  },
  onUnload() {
    this.stopWatchIngest();
  },
  watchIngest() {
    if (!this.data.id || !this.data.ingestBusy) {
      this.stopWatchIngest();
      return;
    }
    if (this.ingestTimer) {
      return;
    }
    this.ingestTimer = setInterval(() => {
      this.reloadVideo(true);
    }, 5000);
  },
  stopWatchIngest() {
    if (this.ingestTimer) {
      clearInterval(this.ingestTimer);
      this.ingestTimer = null;
    }
  },
  loadPosterCanvas() {
    return new Promise((resolve) => {
      wx.createSelectorQuery()
        .in(this)
        .select('#video-poster-canvas')
        .fields({ node: true, size: true })
        .exec((res) => resolve(res && res[0] && res[0].node));
    });
  },
  readVideoPoster(filePath) {
    return captureVideoPoster({
      filePath,
      createDecoder: () => (
        typeof wx.createVideoDecoder === 'function' ? wx.createVideoDecoder() : null
      ),
      loadCanvas: () => this.loadPosterCanvas(),
      exportCanvas: (canvas) => new Promise((resolve) => {
        wx.canvasToTempFilePath({
          canvas,
          fileType: 'jpg',
          quality: 0.92,
          success: (result) => resolve((result && result.tempFilePath) || ''),
          fail: () => resolve(''),
        });
      }),
    });
  },
  uploadVideo() {
    wx.chooseMessageFile({
      count: 1,
      type: 'video',
      success: (res) => {
        const picked = res.tempFiles[0];
        const file = {
          tempFilePath: picked.path,
          name: picked.name,
        };
        const posterTask = this.data.coverFileId
          ? Promise.resolve('')
          : this.readVideoPoster(file.tempFilePath);
        this.setData({ autoTitle: titleFromVideoFile(file) }, () => {
          this.ensureSaved()
          .then(() => this.uploadCloudFile('video', file.tempFilePath, 'mp4'))
          .then((fileID) => posterTask.then((thumb) => ({ fileID, thumb })))
          .then(({ fileID, thumb }) => {
            this.setData({ videoFileId: fileID });
            const plan = planVideoCoverUpload({
              coverFileId: this.data.coverFileId,
              thumbTempFilePath: thumb,
            });
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
              return this.uploadCloudFile('cover', croppedPath, 'jpg').then((coverId) => new Promise((resolve, reject) => {
                this.setData({
                  coverFileId: coverId,
                  posterUrl: croppedPath,
                  coverHint: '未选手动封面，已用视频首帧裁剪',
                }, () => {
                  this.persist(true).then(() => resolve('cover')).catch(reject);
                });
              }));
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
        });
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
      title: effectiveTitle(this.data.humanTitle, this.data.autoTitle),
      intro: effectiveIntro(this.data.humanIntro, this.data.autoIntro),
      autoTitle: this.data.autoTitle,
      humanTitle: this.data.humanTitle,
      humanIntro: this.data.humanIntro,
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
