const { catalog } = require('../../utils/api');
const { withPosterUrls } = require('../../utils/videoMedia');
const { whenCloudReady } = require('../../utils/cloudReady');

Page({
  data: {
    brands: [],
    allVideos: [],
    shelves: [],
    results: [],
    brandId: '',
    query: '',
    searched: false,
    loading: true,
    error: '',
  },
  tapCount: 0,
  onLoad() {
    whenCloudReady(getApp()).then(() => this.load({ showLoading: true }));
  },
  onShow() {
    // 从运营页返回时静默刷新；首次由 onLoad 负责，避免重复请求
    if (this._loadedOnce) {
      this.load({ showLoading: false });
    }
  },
  load(options) {
    const showLoading = !options || options.showLoading !== false;
    const hasContent = (this.data.shelves && this.data.shelves.length) || this.data.brands.length;
    if (showLoading || !hasContent) {
      this.setData({ loading: true, error: '' });
    } else {
      this.setData({ error: '' });
    }
    // 一次云函数取齐品牌+视频，避免低并发环境两次 callFunction 排队
    catalog({ action: 'listHome' })
      .then((res) => {
        const brands = res.brands || [];
        const allVideos = withPosterUrls(res.videos || []);
        this._loadedOnce = true;
        this.setData({ brands, allVideos, loading: false });
        this.paintShelves();
      })
      .catch((err) => {
        this.setData({ loading: false, error: err.message || '加载失败' });
      });
  },
  paintShelves() {
    const brandId = this.data.brandId;
    const brands = this.data.brands;
    const videos = this.data.allVideos.filter((item) => !brandId || item.brandId === brandId);
    const shelves = brands
      .filter((brand) => !brandId || brand._id === brandId)
      .map((brand) => ({
        id: brand._id,
        brand: Object.assign({}, brand, { initial: String(brand.name || '优').slice(0, 1) }),
        items: videos.filter((item) => item.brandId === brand._id),
      }))
      .filter((shelf) => shelf.items.length);
    this.setData({ shelves, searched: false, results: [] });
  },
  onQuery(e) {
    this.setData({ query: e.detail.value });
  },
  onSearch() {
    const query = (this.data.query || '').trim();
    if (!query) {
      this.paintShelves();
      return;
    }
    this.setData({ loading: true, searched: true });
    catalog({ action: 'search', query })
      .then((res) => {
        let results = withPosterUrls(res.videos || []).map((item) =>
          Object.assign({}, item, {
            initial: String(item.brandName || '优').slice(0, 1),
          }),
        );
        if (this.data.brandId) {
          results = results.filter((item) => item.brandId === this.data.brandId);
        }
        this.setData({ results, loading: false });
      })
      .catch((err) => {
        this.setData({ loading: false });
        wx.showToast({ title: err.message || '搜索失败', icon: 'none' });
      });
  },
  onBrandTap(e) {
    const id = e.currentTarget.dataset.id || '';
    this.setData({ brandId: id });
    const query = (this.data.query || '').trim();
    if (!query) {
      this.paintShelves();
      return;
    }
    this.onSearch();
  },
  onVideoTap(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/player/player?id=${id}` });
  },
  onTitleTap() {
    this.tapCount += 1;
    if (this.tapCount >= 8) {
      this.tapCount = 0;
      wx.navigateTo({ url: '/pages/admin/login/login' });
    }
  },
});
