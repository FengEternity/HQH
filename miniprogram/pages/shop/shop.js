const { shop } = require('../../utils/api');
const { formatPriceYuan } = require('../../utils/shopPrice');

Page({
  data: {
    products: [],
    loading: true,
  },
  onShow() {
    this.load();
  },
  load() {
    this.setData({ loading: true });
    shop({ action: 'listPublishedShop' })
      .then((res) => {
        const products = (res.products || []).map((item) =>
          Object.assign({}, item, {
            priceYuan: formatPriceYuan(item.priceFen),
          }),
        );
        this.setData({ products, loading: false });
        return this.resolveCovers(products);
      })
      .catch((err) => {
        this.setData({ loading: false });
        wx.showToast({ title: err.message || '加载失败', icon: 'none' });
      });
  },
  resolveCovers(products) {
    const cloudIds = products
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
      const next = products.map((item) =>
        Object.assign({}, item, {
          coverUrl: map[item.coverFileId] || item.coverFileId || '',
        }),
      );
      this.setData({ products: next });
    });
  },
  openProduct(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/shop-detail/shop-detail?id=${id}` });
  },
});
