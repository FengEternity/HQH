const { admin } = require('../../../utils/api');
const { isReadyToPublish } = require('../../../utils/videoPublishGate');

function statusLabel(status) {
  if (status === 'published') {
    return '已上架';
  }
  if (status === 'unpublished') {
    return '已下架';
  }
  return '草稿';
}

Page({
  data: {
    brandId: '',
    brandName: '',
    videos: [],
  },
  onLoad(query) {
    this.setData({
      brandId: query.brandId || '',
      brandName: decodeURIComponent(query.name || ''),
    });
    if (query.name) {
      wx.setNavigationBarTitle({ title: query.name });
    }
  },
  onShow() {
    this.load();
  },
  load() {
    if (!this.data.brandId) {
      wx.showToast({ title: '缺少品牌', icon: 'none' });
      return;
    }
    admin({ action: 'adminListVideos', brandId: this.data.brandId })
      .then((res) => {
        const videos = (res.videos || []).map((item) =>
          Object.assign({}, item, {
            statusLabel: statusLabel(item.status),
            canPublish: item.status !== 'published' && isReadyToPublish(item),
            canUnpublish: item.status === 'published',
            initial: String(item.title || '片').slice(0, 1),
          }),
        );
        this.setData({ videos });
      })
      .catch((err) => {
        if (err.code === 'UNAUTHORIZED') {
          wx.redirectTo({ url: '/pages/admin/login/login' });
          return;
        }
        wx.showToast({ title: err.message || '加载失败', icon: 'none' });
      });
  },
  newVideo() {
    wx.navigateTo({
      url: `/pages/admin/edit/edit?brandId=${this.data.brandId}`,
    });
  },
  editVideo(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/admin/edit/edit?brandId=${this.data.brandId}&id=${id}`,
    });
  },
  publish(e) {
    admin({ action: 'publishVideo', id: e.currentTarget.dataset.id })
      .then(() => {
        wx.showToast({ title: '已上架' });
        this.load();
      })
      .catch((err) => wx.showToast({ title: err.message || '上架失败', icon: 'none' }));
  },
  unpublish(e) {
    admin({ action: 'unpublishVideo', id: e.currentTarget.dataset.id })
      .then(() => {
        wx.showToast({ title: '已下架' });
        this.load();
      })
      .catch((err) => wx.showToast({ title: err.message || '下架失败', icon: 'none' }));
  },
  remove(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '彻底删除',
      content: '记录和已上传文件都会去掉，不能恢复。',
      confirmText: '删除',
      confirmColor: '#b42318',
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        admin({ action: 'deleteVideo', id })
          .then(() => {
            wx.showToast({ title: '已删除' });
            this.load();
          })
          .catch((err) => wx.showToast({ title: err.message || '删除失败', icon: 'none' }));
      },
    });
  },
});
