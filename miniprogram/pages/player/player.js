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
        } else {
          const posterUrl = String((video && video.posterUrl) || '').trim();
          this.setData({
            video: posterUrl ? Object.assign({}, video, { posterUrl }) : video,
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
