const { catalog } = require('../../utils/api');

Page({
  data: {
    brandId: '',
    name: '',
    videos: [],
    tag: '',
    loading: true,
  },
  onLoad(query) {
    const brandId = query.id || '';
    const name = decodeURIComponent(query.name || '');
    wx.setNavigationBarTitle({ title: name || '品牌' });
    this.setData({ brandId, name });
    this.load();
  },
  load() {
    const { brandId, tag } = this.data;
    this.setData({ loading: true });
    catalog({ action: 'listPublished', brandId, tag })
      .then((res) => {
        this.setData({ videos: res.videos || [], loading: false });
      })
      .catch(() => this.setData({ loading: false, videos: [] }));
  },
  onTag(e) {
    this.setData({ tag: e.detail.value });
  },
  onFilter() {
    this.load();
  },
  onVideoTap(e) {
    wx.navigateTo({ url: `/pages/player/player?id=${e.currentTarget.dataset.id}` });
  },
});
