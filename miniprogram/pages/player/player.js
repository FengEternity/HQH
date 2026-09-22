const { catalog, shop } = require('../../utils/api');
const { formatPriceYuan } = require('../../utils/shopPrice');

function httpsUrl(value) {
  const url = String(value || '').trim();
  return /^https:\/\//i.test(url) ? url : '';
}

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
    catalog({ action: 'getVideo', id })
      .then((res) => {
        const video = res.video;
        if (video && video.title) {
          wx.setNavigationBarTitle({ title: video.title });
        }
        const src = String((res && res.videoUrl) || '').trim();
        const posterUrl = httpsUrl(video && video.posterUrl);
        const nextVideo = Object.assign({}, video, {
          posterUrl,
          tags: Array.isArray(video && video.tags) ? video.tags : [],
        });
        if (!src) {
          this.setData({
            video: nextVideo,
            error:
              video && video.videoFileId
                ? '视频地址未返回。请重新上传部署 catalog 云函数后再试'
                : '',
          });
        } else {
          this.setData({
            video: nextVideo,
            src,
          });
        }
        return shop({ action: 'listLinkedShopProducts', videoId: id }).catch(() => ({
          products: [],
        }));
      })
      .then((shopRes) => {
        const shopProducts = (shopRes.products || []).map((item) =>
          Object.assign({}, item, {
            priceYuan: formatPriceYuan(item.priceFen),
          }),
        );
        this.setData({ shopProducts });
        return this.resolveShopCovers(shopProducts);
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
  resolveShopCovers(products) {
    const cloudIds = (products || [])
      .map((item) => item.coverFileId)
      .filter((id) => String(id || '').indexOf('cloud://') === 0);
    if (!cloudIds.length) {
      return Promise.resolve();
    }
    return wx.cloud.getTempFileURL({ fileList: cloudIds }).then((fileRes) => {
      const map = Object.create(null);
      for (const row of (fileRes && fileRes.fileList) || []) {
        if (row.fileID && row.tempFileURL) {
          map[row.fileID] = row.tempFileURL;
        }
      }
      const shopProducts = (this.data.shopProducts || []).map((item) =>
        Object.assign({}, item, {
          coverUrl: map[item.coverFileId] || item.coverFileId || '',
        }),
      );
      this.setData({ shopProducts });
    });
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
