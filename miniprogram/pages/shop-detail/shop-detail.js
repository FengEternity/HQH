const { shop } = require('../../utils/api');
const { formatPriceYuan } = require('../../utils/shopPrice');

Page({
  data: {
    product: null,
    videos: [],
    error: '',
    loading: true,
  },
  onLoad(query) {
    const id = query.id;
    if (!id) {
      this.setData({ loading: false, error: '商品不存在' });
      return;
    }
    shop({ action: 'getPublishedShop', id })
      .then((res) => {
        const product = Object.assign({}, res.product, {
          priceYuan: formatPriceYuan(res.product.priceFen),
        });
        this.setData({ product, loading: false });
        if (product.name) {
          wx.setNavigationBarTitle({ title: product.name });
        }
        return Promise.all([
          this.resolveCover(product.coverFileId),
          shop({ action: 'listLinkedVideos', shopProductId: product._id }),
        ]);
      })
      .then((results) => {
        if (!results) {
          return;
        }
        const linkRes = results[1];
        this.setData({ videos: (linkRes && linkRes.videos) || [] });
      })
      .catch((err) => {
        this.setData({
          loading: false,
          error: err.message || '商品不存在',
        });
      });
  },
  resolveCover(fileId) {
    const id = String(fileId || '');
    if (!id) {
      return Promise.resolve();
    }
    if (id.indexOf('cloud://') !== 0) {
      this.setData({
        product: Object.assign({}, this.data.product, { coverUrl: id }),
      });
      return Promise.resolve();
    }
    return wx.cloud.getTempFileURL({ fileList: [id] }).then((fileRes) => {
      const row = fileRes && fileRes.fileList && fileRes.fileList[0];
      if (row && row.tempFileURL && this.data.product) {
        this.setData({
          product: Object.assign({}, this.data.product, { coverUrl: row.tempFileURL }),
        });
      }
    });
  },
  openVideo(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/player/player?id=${id}` });
  },
});
