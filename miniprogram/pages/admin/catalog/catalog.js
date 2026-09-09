const { admin } = require('../../../utils/api');

Page({
  data: {
    brands: [],
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
    const hasContent = this.data.brands && this.data.brands.length;
    if (showLoading || !hasContent) {
      this.setData({ loading: true });
    }
    admin({ action: 'adminListBrands' })
      .then((brandRes) => {
        const brands = (brandRes.brands || []).map((item) =>
          Object.assign({}, item, {
            videoCount: item.videoCount || 0,
            sort: item.sort === undefined ? 99 : item.sort,
          }),
        );
        this._loadedOnce = true;
        this.setData({ brands, loading: false });
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
  addBrand() {
    wx.navigateTo({ url: '/pages/admin/brand/brand' });
  },
  editBrand(e) {
    wx.navigateTo({ url: `/pages/admin/brand/brand?id=${e.currentTarget.dataset.id}` });
  },
  openBrand(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    wx.navigateTo({
      url: `/pages/admin/videos/videos?brandId=${id}&name=${encodeURIComponent(name || '')}`,
    });
  },
});
