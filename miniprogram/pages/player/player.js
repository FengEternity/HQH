const { catalog, shop } = require('../../utils/api');
const { withPosterUrl } = require('../../utils/videoMedia');
const { formatPriceYuan } = require('../../utils/shopPrice');

Page({
  data: {
    videoId: '',
    video: null,
    src: '',
    error: '',
    shopProducts: [],
    tab: 'intro',
    inputDraft: '',
    messages: [],
    currentTimeSec: 0,
  },
  onLoad(query) {
    const id = String((query && query.id) || '').trim();
    this._currentTimeSec = 0;
    this.setData({ videoId: id });
    const videoTask = catalog({ action: 'getVideo', id });
    const shopTask = shop({ action: 'listLinkedShopProducts', videoId: id }).catch(() => ({
      products: [],
    }));
    return Promise.all([videoTask, shopTask])
      .then(([res, shopRes]) => {
        const video = withPosterUrl(res.video);
        if (video && video.title) {
          wx.setNavigationBarTitle({ title: video.title });
        }
        const src = String((res && res.videoUrl) || '').trim();
        const nextVideo = video
          ? Object.assign({}, video, {
              tags: Array.isArray(video.tags) ? video.tags : [],
            })
          : null;
        const shopProducts = (shopRes.products || []).map((item) =>
          Object.assign({}, item, {
            priceYuan: formatPriceYuan(item.priceFen),
          }),
        );
        const patch = {
          video: nextVideo,
          shopProducts,
          error: '',
        };
        if (!src) {
          patch.error =
            nextVideo && nextVideo.videoFileId
              ? '视频地址未返回。请重新上传部署 catalog 云函数后再试'
              : '暂无视频文件';
        } else {
          patch.src = src;
        }
        return this.attachShopCovers(shopProducts).then((covered) => {
          patch.shopProducts = covered;
          this.setData(patch);
        });
      })
      .catch((err) => {
        this.setData({ error: err.message || '无法播放' });
      });
  },
  onTabTap(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab !== 'intro' && tab !== 'ask') {
      return;
    }
    if (tab === this.data.tab) {
      return;
    }
    this.setData({ tab, currentTimeSec: this._currentTimeSec || 0 });
  },
  onTimeUpdate(e) {
    const sec = Math.floor(Number(e.detail && e.detail.currentTime) || 0);
    this._currentTimeSec = sec;
  },
  onAskInput(e) {
    this.setData({ inputDraft: e.detail.value });
  },
  onAskSend() {
    // 预留：agent({ profile: 'video_doc', message, videoId, currentTimeSec })
    wx.showToast({ title: '本片问答即将开放', icon: 'none' });
  },
  attachShopCovers(products) {
    const cloudIds = (products || [])
      .map((item) => item.coverFileId)
      .filter((id) => String(id || '').indexOf('cloud://') === 0);
    if (!cloudIds.length || !wx.cloud || typeof wx.cloud.getTempFileURL !== 'function') {
      return Promise.resolve(products);
    }
    return wx.cloud
      .getTempFileURL({ fileList: cloudIds })
      .then((fileRes) => {
        const map = Object.create(null);
        for (const row of (fileRes && fileRes.fileList) || []) {
          if (row.fileID && row.tempFileURL) {
            map[row.fileID] = row.tempFileURL;
          }
        }
        return (products || []).map((item) =>
          Object.assign({}, item, {
            coverUrl: map[item.coverFileId] || '',
          }),
        );
      })
      .catch(() => products);
  },
  openShopProduct(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/shop-detail/shop-detail?id=${id}` });
  },
  onVideoError() {
    this.setData({
      error: '视频无法播放，请确认已上传云存储文件。',
    });
  },
});
