const { admin } = require('../../../utils/api');

Page({
  data: {
    brands: [],
    unreadLabel: '0 条未读',
  },
  onShow() {
    this.load();
  },
  load() {
    Promise.all([admin({ action: 'adminListBrands' }), admin({ action: 'adminListSupport' })])
      .then(([brandRes, inboxRes]) => {
        const brands = (brandRes.brands || []).map((item) =>
          Object.assign({}, item, {
            initial: String(item.name || '品').slice(0, 1),
            videoCount: item.videoCount || 0,
            sort: item.sort === undefined ? 99 : item.sort,
          }),
        );
        const unread = inboxRes.unreadCount || 0;
        this.setData({
          brands,
          unreadLabel: unread ? unread + ' 条未读' : '暂无未读',
        });
      })
      .catch((err) => {
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
  openInbox() {
    wx.navigateTo({ url: '/pages/admin/inbox/inbox' });
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
