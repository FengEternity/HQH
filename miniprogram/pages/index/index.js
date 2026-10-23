const { catalog } = require('../../utils/api');
const { withPosterUrls } = require('../../utils/videoMedia');
const { whenCloudReady } = require('../../utils/cloudReady');
const {
  callWithVisitorRetry,
  visitorCatalogMessage,
} = require('../../utils/catalogVisitorError');

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
  // 正式版发布后删除：连点标题八次进入运营登录。
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
    const seq = (this._loadSeq || 0) + 1;
    this._loadSeq = seq;
    if (showLoading || !hasContent) {
      this.setData({ loading: true, error: '' });
    } else {
      this.setData({ error: '' });
    }
    // 一次云函数取齐品牌+视频，避免低并发环境两次 callFunction 排队。
    // 短暂失败再静默请求一次；未部署或依赖缺失不会因为重试变好。
    return callWithVisitorRetry(() => catalog({ action: 'listHome' }))
      .then((res) => {
        if (seq !== this._loadSeq) {
          return;
        }
        const brands = res.brands || [];
        const allVideos = withPosterUrls(res.videos || []);
        this._loadedOnce = true;
        this.setData({ brands, allVideos, loading: false, error: '' });
        this.paintShelves();
      })
      .catch((err) => {
        if (seq !== this._loadSeq) {
          return;
        }
        console.error('listHome failed', err);
        const message = visitorCatalogMessage('load');
        if (!showLoading && hasContent) {
          this.setData({ loading: false });
          wx.showToast({ title: message, icon: 'none' });
          return;
        }
        this.setData({ loading: false, error: message });
      });
  },
  onRetry() {
    return this.load({ showLoading: true });
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
    const seq = (this._searchSeq || 0) + 1;
    this._searchSeq = seq;
    this.setData({ loading: true, error: '' });
    return callWithVisitorRetry(() => catalog({ action: 'search', query }))
      .then((res) => {
        if (seq !== this._searchSeq) {
          return;
        }
        let results = withPosterUrls(res.videos || []).map((item) =>
          Object.assign({}, item, {
            initial: String(item.brandName || '优').slice(0, 1),
          }),
        );
        if (this.data.brandId) {
          results = results.filter((item) => item.brandId === this.data.brandId);
        }
        this.setData({ results, loading: false, searched: true, error: '' });
      })
      .catch((err) => {
        if (seq !== this._searchSeq) {
          return;
        }
        console.error('search failed', err);
        const stillEmpty =
          !(this.data.shelves && this.data.shelves.length) && !this.data.brands.length;
        this.setData({
          loading: false,
          error: stillEmpty ? visitorCatalogMessage('load') : '',
        });
        wx.showToast({ title: visitorCatalogMessage('search'), icon: 'none' });
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
