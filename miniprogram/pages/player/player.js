const { catalog, shop } = require('../../utils/api');
const { withPosterUrl } = require('../../utils/videoMedia');
const { formatPriceYuan } = require('../../utils/shopPrice');

Page({
  data: {
    video: null,
    src: '',
    error: '',
    shopProducts: [],
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
          shop({ action: 'listLinkedShopProducts', videoId: id }).catch(() => ({ products: [] })),
        ]);
      })
      .then(([src, posterUrl, shopRes]) => {
        const patch = {
          shopProducts: (shopRes.products || []).map((item) =>
            Object.assign({}, item, {
              priceYuan: formatPriceYuan(item.priceFen),
            }),
          ),
        };
        if (src) {
          patch.src = src;
        }
        if (posterUrl && this.data.video) {
          patch.video = Object.assign({}, this.data.video, { posterUrl });
        }
        this.setData(patch);
        return this.resolveShopCovers(patch.shopProducts);
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
