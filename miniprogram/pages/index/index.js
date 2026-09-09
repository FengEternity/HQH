const { catalog, aiSearch } = require('../../utils/api');

Page({
  data: {
    brands: [],
    allVideos: [],
    shelves: [],
    results: [],
    brandId: '',
    query: '',
    searched: false,
    searchedAi: false,
    aiAnswer: '',
    loading: true,
    error: '',
  },
  tapCount: 0,
  onShow() {
    this.load();
  },
  load() {
    this.setData({ loading: true, error: '' });
    Promise.all([catalog({ action: 'listBrands' }), catalog({ action: 'listPublished' })])
      .then(([brandRes, videoRes]) => {
        const brands = brandRes.brands || [];
        const allVideos = videoRes.videos || [];
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
    this.setData({ shelves, searched: false, searchedAi: false, results: [], aiAnswer: '' });
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
    this.setData({ loading: true, searched: true, searchedAi: false, aiAnswer: '' });
    catalog({ action: 'search', query })
      .then((res) => {
        let results = (res.videos || []).map((item) =>
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
  onAiSearch() {
    const query = (this.data.query || '').trim();
    if (!query) {
      wx.showToast({ title: '请输入问题', icon: 'none' });
      return;
    }
    this.setData({ loading: true, searched: true, searchedAi: true, error: '' });
    aiSearch(query, this.data.brandId)
      .then((res) => {
        const results = (res.videos || []).map((item) =>
          Object.assign({}, item, {
            initial: String(item.brandName || '优').slice(0, 1),
          }),
        );
        this.setData({ results, aiAnswer: res.answer || '', loading: false });
      })
      .catch((err) => {
        this.setData({ loading: false, results: [], aiAnswer: '' });
        wx.showToast({ title: err.message || 'AI 搜索失败', icon: 'none' });
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
    if (this.data.searchedAi) {
      this.onAiSearch();
    } else {
      this.onSearch();
    }
  },
  onVideoTap(e) {
    const id = e.currentTarget.dataset.id;
    const t = Number(e.currentTarget.dataset.t);
    let url = `/pages/player/player?id=${id}`;
    if (!Number.isNaN(t) && t > 0) {
      url += `&t=${t}`;
    }
    wx.navigateTo({ url });
  },
  onTitleTap() {
    this.tapCount += 1;
    if (this.tapCount >= 8) {
      this.tapCount = 0;
      wx.navigateTo({ url: '/pages/admin/login/login' });
    }
  },
  openContact() {
    wx.navigateTo({ url: '/pages/contact/contact' });
  },
});
