const { admin } = require('../../../utils/api');
const { withPosterUrl, displayedPoster, posterUrlFromList, cloudUploadOptions } = require('../../../utils/videoMedia');

function noticeAfterPicker(title) {
  setTimeout(() => {
    wx.showToast({ title, icon: 'none' });
  }, 400);
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

function draftFieldState(copies, typed) {
  const source = copies && typeof copies === 'object' ? copies : {};
  const humanTitle = cleanText(source.humanTitle);
  const autoTitle = cleanText(source.autoTitle);
  const humanIntro = withoutPlaceholder(source.humanIntro);
  const autoIntro = withoutPlaceholder(source.autoIntro);
  const hasTypedTitle = typed && Object.prototype.hasOwnProperty.call(typed, 'titleText');
  const hasTypedIntro = typed && Object.prototype.hasOwnProperty.call(typed, 'introText');
  return {
    autoTitle,
    humanTitle,
    autoIntro,
    humanIntro,
    titleText: hasTypedTitle ? typed.titleText : (humanTitle || autoTitle),
    introText: hasTypedIntro ? typed.introText : (humanIntro || autoIntro),
    canReplaceTitle: Boolean(humanTitle && autoTitle && humanTitle !== autoTitle),
    canReplaceIntro: Boolean(humanIntro && autoIntro && humanIntro !== autoIntro),
  };
}

function humanCopyFromInput(value, autoValue) {
  const text = cleanText(value);
  return text === cleanText(autoValue) ? '' : text;
}

function titleFromVideoFile(file) {
  const named = String((file && (file.name || file.fileName)) || '').trim();
  if (!named) {
    return '';
  }
  const base = named.split(/[/\\]/).pop();
  return base.replace(/\.[^.]+$/, '').trim();
}

function videoSourceLabels(platform) {
  const local = platform === 'windows' || platform === 'mac' ? '从电脑文件夹' : '从手机相册';
  return [local, '从聊天记录'];
}

function currentPlatform() {
  if (typeof wx.getSystemInfoSync !== 'function') {
    return '';
  }
  const info = wx.getSystemInfoSync() || {};
  return info.platform || '';
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
    titleText: '',
    introText: '',
    canReplaceTitle: false,
    canReplaceIntro: false,
    modelName: '',
    tags: '',
    coverFileId: '',
    videoFileId: '',
    posterUrl: '',
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
    const fields = draftFieldState(
      keepEdits
        ? {
            humanTitle: this.data.humanTitle,
            autoTitle: copies.autoTitle,
            humanIntro: this.data.humanIntro,
            autoIntro: copies.autoIntro,
          }
        : copies,
    );
    this.setData(
      Object.assign(
        fields,
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
    if (!coverFileId) {
      return;
    }
    const applyUrl = (url) => {
      const posterUrl = posterUrlFromList([{ _id: this.data.id, posterUrl: url }], this.data.id);
      if (posterUrl && this.data.coverFileId === coverFileId) {
        this.setData({ posterUrl });
      }
    };
    const listed = this.data.brandId && this.data.id
      ? admin({ action: 'adminListVideos', brandId: this.data.brandId })
        .then((res) => applyUrl(posterUrlFromList(res && res.videos, this.data.id)))
        .catch(() => {})
      : Promise.resolve();
    listed.then(() => {
      if (this.data.posterUrl || typeof wx === 'undefined' || !wx.cloud || !wx.cloud.getTempFileURL) {
        return;
      }
      wx.cloud.getTempFileURL({ fileList: [coverFileId] }).then((res) => {
        const row = res && res.fileList && res.fileList[0];
        applyUrl(row && row.tempFileURL);
      }).catch(() => {});
    });
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
  onTitle(e) {
    const titleText = e.detail.value;
    this.setData(draftFieldState({
      humanTitle: humanCopyFromInput(titleText, this.data.autoTitle),
      autoTitle: this.data.autoTitle,
      humanIntro: this.data.humanIntro,
      autoIntro: this.data.autoIntro,
    }, { titleText, introText: this.data.introText }));
  },
  onIntro(e) {
    const introText = e.detail.value;
    this.setData(draftFieldState({
      humanTitle: this.data.humanTitle,
      autoTitle: this.data.autoTitle,
      humanIntro: humanCopyFromInput(introText, this.data.autoIntro),
      autoIntro: this.data.autoIntro,
    }, { titleText: this.data.titleText, introText }));
  },
  replaceTitle() {
    if (!this.data.canReplaceTitle) {
      return;
    }
    this.setData(draftFieldState({
      humanTitle: '',
      autoTitle: this.data.autoTitle,
      humanIntro: this.data.humanIntro,
      autoIntro: this.data.autoIntro,
    }), () => {
      this.persist(true).catch((err) => {
        wx.showToast({ title: err.message || '替换失败', icon: 'none' });
      });
    });
  },
  replaceIntro() {
    if (!this.data.canReplaceIntro) {
      return;
    }
    this.setData(draftFieldState({
      humanTitle: this.data.humanTitle,
      autoTitle: this.data.autoTitle,
      humanIntro: '',
      autoIntro: this.data.autoIntro,
    }), () => {
      this.persist(true).catch((err) => {
        wx.showToast({ title: err.message || '替换失败', icon: 'none' });
      });
    });
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
  uploadVideo() {
    wx.showActionSheet({
      itemList: videoSourceLabels(currentPlatform()),
      success: (res) => {
        if (res.tapIndex === 0) {
          this.pickLocalVideo();
          return;
        }
        if (res.tapIndex === 1) {
          this.pickChatVideo();
        }
      },
    });
  },
  pickLocalVideo() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['video'],
      sourceType: ['album'],
      sizeType: ['original'],
      success: (res) => {
        const picked = (res.tempFiles || [])[0];
        if (!picked || !picked.tempFilePath) {
          return;
        }
        this.acceptPickedVideo({
          tempFilePath: picked.tempFilePath,
          name: picked.name || '',
        });
      },
      fail: (err) => this.showPickError(err),
    });
  },
  pickChatVideo() {
    wx.chooseMessageFile({
      count: 1,
      type: 'video',
      success: (res) => {
        const picked = (res.tempFiles || [])[0];
        if (!picked || !picked.path) {
          return;
        }
        this.acceptPickedVideo({
          tempFilePath: picked.path,
          name: picked.name || '',
        });
      },
      fail: (err) => this.showPickError(err),
    });
  },
  showPickError(err) {
    const message = err && err.errMsg ? err.errMsg : '';
    if (/cancel/i.test(message)) {
      return;
    }
    wx.showToast({ title: '没有选到视频', icon: 'none' });
  },
  acceptPickedVideo(file) {
    const named = titleFromVideoFile(file);
    const autoTitle = named || cleanText(this.data.autoTitle);
    const fields = draftFieldState({
      humanTitle: this.data.humanTitle,
      autoTitle,
      humanIntro: this.data.humanIntro,
      autoIntro: this.data.autoIntro,
    }, cleanText(this.data.humanTitle)
      ? { titleText: this.data.titleText, introText: this.data.introText }
      : undefined);
    this.setData(fields, () => {
      this.ensureSaved()
        .then(() => this.uploadCloudFile('video', file.tempFilePath, 'mp4'))
        .then((fileID) => new Promise((resolve, reject) => {
          this.setData({ videoFileId: fileID }, () => {
            this.persistUploadedVideo().then(resolve).catch(reject);
          });
        }))
        .then(() => this.reloadVideo())
        .then(() => {
          wx.showToast({ title: '视频已保存，封面将在后台补齐', icon: 'none' });
        })
        .catch((err) => wx.showToast({ title: err.message || '上传失败', icon: 'none' }));
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
