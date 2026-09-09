const { admin } = require('../../../utils/api');

Page({
  data: {
    id: '',
    name: '',
    sort: '',
    videoCount: 0,
    saving: false,
  },
  onLoad(query) {
    const id = query.id || '';
    this.setData({ id });
    wx.setNavigationBarTitle({ title: id ? '编辑品牌' : '新建品牌' });
    if (!id) {
      return;
    }
    admin({ action: 'adminListBrands' })
      .then((res) => {
        const found = (res.brands || []).find((item) => item._id === id);
        if (!found) {
          wx.showToast({ title: '品牌不存在', icon: 'none' });
          return;
        }
        this.setData({
          name: found.name || '',
          sort: String(found.sort === undefined ? '' : found.sort),
          videoCount: found.videoCount || 0,
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
  onName(e) {
    this.setData({ name: e.detail.value });
  },
  onSort(e) {
    this.setData({ sort: e.detail.value });
  },
  save() {
    const name = this.data.name.trim();
    if (!name) {
      wx.showToast({ title: '品牌名必填', icon: 'none' });
      return;
    }
    if (this.data.saving) {
      return;
    }
    this.setData({ saving: true });
    admin({
      action: 'upsertBrand',
      id: this.data.id || undefined,
      name,
      sort: this.data.sort === '' ? undefined : Number(this.data.sort),
    })
      .then(() => {
        this.setData({ saving: false });
        wx.showToast({ title: '已保存' });
        setTimeout(() => wx.navigateBack(), 600);
      })
      .catch((err) => {
        this.setData({ saving: false });
        wx.showToast({ title: err.message || '保存失败', icon: 'none' });
      });
  },
  openVideos() {
    wx.navigateTo({
      url: `/pages/admin/videos/videos?brandId=${this.data.id}&name=${encodeURIComponent(this.data.name)}`,
    });
  },
  remove() {
    wx.showModal({
      title: '删除品牌',
      content: '品牌会从首页和搜索里消失，不能恢复。',
      confirmText: '删除',
      confirmColor: '#b42318',
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        admin({ action: 'deleteBrand', id: this.data.id })
          .then(() => {
            wx.showToast({ title: '已删除' });
            setTimeout(() => wx.navigateBack(), 600);
          })
          .catch((err) => {
            wx.showModal({
              title: '删不掉',
              content: err.message || '删除失败',
              showCancel: false,
            });
          });
      },
    });
  },
});
