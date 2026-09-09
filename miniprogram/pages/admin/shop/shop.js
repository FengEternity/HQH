const { shopAdmin } = require('../../../utils/api');
const { formatPriceYuan } = require('../../../utils/shopPrice');

function statusLabel(status) {
  if (status === 'published') {
    return '已上架';
  }
  return '未上架';
}

Page({
  data: {
    products: [],
    loading: true,
  },
  onLoad() {
    this.load({ showLoading: true });
  },
  onShow() {
    if (this._loadedOnce) {
      this.load({ showLoading: false });
    }
  },
  load(options) {
    const showLoading = !options || options.showLoading !== false;
    const hasContent = this.data.products && this.data.products.length;
    if (showLoading || !hasContent) {
      this.setData({ loading: true });
    }
    shopAdmin({ action: 'listShopAdmin' })
      .then((res) => {
        const products = (res.products || []).map((item) =>
          Object.assign({}, item, {
            statusLabel: statusLabel(item.status),
            priceYuan: formatPriceYuan(item.priceFen),
            canPublish: item.status !== 'published',
            canUnpublish: item.status === 'published',
          }),
        );
        this._loadedOnce = true;
        this.setData({ products, loading: false });
      })
      .catch((err) => {
        this.setData({ loading: false });
        if (err.code === 'UNAUTHORIZED') {
          wx.redirectTo({ url: '/pages/admin/login/login' });
          return;
        }
        wx.showToast({ title: err.message || '加载失败', icon: 'none' });
      });
  },
  addProduct() {
    wx.navigateTo({ url: '/pages/admin/shop-edit/shop-edit' });
  },
  editProduct(e) {
    wx.navigateTo({
      url: `/pages/admin/shop-edit/shop-edit?id=${e.currentTarget.dataset.id}`,
    });
  },
  publish(e) {
    shopAdmin({
      action: 'setShopProductStatus',
      id: e.currentTarget.dataset.id,
      status: 'published',
    })
      .then(() => {
        wx.showToast({ title: '已上架' });
        this.load({ showLoading: false });
      })
      .catch((err) => wx.showToast({ title: err.message || '上架失败', icon: 'none' }));
  },
  unpublish(e) {
    shopAdmin({
      action: 'setShopProductStatus',
      id: e.currentTarget.dataset.id,
      status: 'unpublished',
    })
      .then(() => {
        wx.showToast({ title: '已下架' });
        this.load({ showLoading: false });
      })
      .catch((err) => wx.showToast({ title: err.message || '下架失败', icon: 'none' }));
  },
});
