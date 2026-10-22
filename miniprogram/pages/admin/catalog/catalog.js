const { admin } = require('../../../utils/api');
const { ingestEntryLabel } = require('../../../utils/ingestEntryLabel');

Page({
  data: {
    brands: [],
    loading: true,
    ingestLabel: '进入',
  },
  onLoad() {
    this.load({ showLoading: true });
  },
  onShow() {
    const jobs = [this.loadIngest()];
    if (this._loadedOnce) {
      jobs.push(this.load({ showLoading: false }));
    }
    return Promise.all(jobs);
  },
  loadIngest() {
    return admin({ action: 'getIngestProgress' })
      .then((result) => {
        this.setData({
          ingestLabel: ingestEntryLabel({
            running: result.running,
            queued: result.queued,
            failed: result.failed,
          }),
        });
      })
      .catch((err) => {
        if (err && err.code === 'UNAUTHORIZED') {
          wx.switchTab({ url: '/pages/mine/mine' });
          return;
        }
        this.setData({
          ingestLabel: ingestEntryLabel({ failedToLoad: true }),
        });
      });
  },
  openIngest() {
    wx.navigateTo({ url: '/pages/admin/ingest/ingest' });
  },
  load(options) {
    const showLoading = !options || options.showLoading !== false;
    const hasContent = this.data.brands && this.data.brands.length;
    if (showLoading || !hasContent) {
      this.setData({ loading: true });
    }
    return admin({ action: 'adminListBrands' })
      .then((brandRes) => {
        const brands = (brandRes.brands || []).map((item) =>
          Object.assign({}, item, {
            videoCount: item.videoCount || 0,
          }),
        );
        this._loadedOnce = true;
        this.setData({ brands, loading: false });
      })
      .catch((err) => {
        this.setData({ loading: false });
        if (err.code === 'UNAUTHORIZED') {
          wx.switchTab({ url: '/pages/mine/mine' });
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
