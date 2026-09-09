const { shopAdmin } = require('../../../utils/api');
const { formatPriceYuan, yuanToFen } = require('../../../utils/shopPrice');
const { buildUpsertShopProductRequest } = require('../../../utils/shopEditSave');

Page({
  data: {
    id: '',
    name: '',
    priceYuan: '',
    coverFileId: '',
    coverUrl: '',
    detail: '',
    specName: '',
    specValue: '',
    category: '',
    status: 'unpublished',
    videos: [],
    canSave: false,
  },
  onLoad(query) {
    // URL id 仅作待加载目标；加载失败时不得带着它去 upsert
    this._pendingId = String(query.id || '').trim();
    this._hydrated = false;
    this._linksReady = false;
    shopAdmin({ action: 'listShopAdmin' })
      .then((res) => {
        const videos = (res.videos || []).map((item) =>
          Object.assign({}, item, {
            checked: false,
            statusLabel:
              item.status === 'published'
                ? '已上架'
                : item.status === 'unpublished'
                  ? '已下架'
                  : '草稿',
          }),
        );
        if (!this._pendingId) {
          this._hydrated = true;
          this._linksReady = true;
          this.setData({ videos, canSave: true });
          return;
        }
        const found = (res.products || []).find((item) => item._id === this._pendingId);
        if (!found) {
          this._hydrated = false;
          this._linksReady = false;
          this.setData({ id: '', videos, canSave: false });
          wx.showToast({ title: '商品不存在', icon: 'none' });
          return;
        }
        const selected = Object.create(null);
        for (const videoId of found.videoIds || []) {
          selected[videoId] = true;
        }
        this._hydrated = true;
        this._linksReady = true;
        this.setData({
          id: found._id,
          name: found.name || '',
          priceYuan: formatPriceYuan(found.priceFen),
          coverFileId: found.coverFileId || '',
          detail: found.detail || '',
          specName: found.specName || '',
          specValue: found.specValue || '',
          category: found.category || '',
          status: found.status || 'unpublished',
          videos: videos.map((item) => Object.assign({}, item, { checked: !!selected[item._id] })),
          canSave: true,
        });
        return this.resolveCover(found.coverFileId);
      })
      .catch((err) => {
        this._hydrated = false;
        this._linksReady = false;
        this.setData({ id: '', canSave: false });
        if (err.code === 'UNAUTHORIZED') {
          wx.redirectTo({ url: '/pages/admin/login/login' });
          return;
        }
        wx.showToast({ title: err.message || '加载失败', icon: 'none' });
      });
  },
  resolveCover(fileId) {
    const id = String(fileId || '');
    if (id.indexOf('cloud://') !== 0) {
      if (id) {
        this.setData({ coverUrl: id });
      }
      return Promise.resolve();
    }
    return wx.cloud.getTempFileURL({ fileList: [id] }).then((fileRes) => {
      const row = fileRes && fileRes.fileList && fileRes.fileList[0];
      if (row && row.tempFileURL) {
        this.setData({ coverUrl: row.tempFileURL });
      }
    });
  },
  onName(e) {
    this.setData({ name: e.detail.value });
  },
  onPrice(e) {
    this.setData({ priceYuan: e.detail.value });
  },
  onDetail(e) {
    this.setData({ detail: e.detail.value });
  },
  onSpecName(e) {
    this.setData({ specName: e.detail.value });
  },
  onSpecValue(e) {
    this.setData({ specValue: e.detail.value });
  },
  onCategory(e) {
    this.setData({ category: e.detail.value });
  },
  toggleVideo(e) {
    if (!this._linksReady) {
      return;
    }
    const id = e.currentTarget.dataset.id;
    const videos = (this.data.videos || []).map((item) =>
      item._id === id ? Object.assign({}, item, { checked: !item.checked }) : item,
    );
    this.setData({ videos });
  },
  pickCover() {
    if (!this._hydrated) {
      wx.showToast({ title: '请先等待加载完成', icon: 'none' });
      return;
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: (res) => {
        const filePath = res.tempFiles[0].tempFilePath;
        const cloudPath = `shop-cover/${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`;
        wx.showLoading({ title: '上传中' });
        wx.cloud
          .uploadFile({ cloudPath, filePath })
          .then((up) => {
            wx.hideLoading();
            this.setData({ coverFileId: up.fileID, coverUrl: filePath });
          })
          .catch(() => {
            wx.hideLoading();
            wx.showToast({ title: '上传失败', icon: 'none' });
          });
      },
    });
  },
  selectedVideoIds() {
    return (this.data.videos || []).filter((item) => item.checked).map((item) => item._id);
  },
  save() {
    const priceFen = yuanToFen(this.data.priceYuan);
    if (!Number.isInteger(priceFen)) {
      wx.showToast({ title: '价格无效', icon: 'none' });
      return;
    }
    const built = buildUpsertShopProductRequest({
      hydrated: this._hydrated,
      linksReady: this._linksReady,
      id: this.data.id,
      fields: {
        name: this.data.name,
        priceFen,
        coverFileId: this.data.coverFileId,
        detail: this.data.detail,
        specName: this.data.specName,
        specValue: this.data.specValue,
        category: this.data.category,
        status: this.data.status || 'unpublished',
      },
      selectedVideoIds: this.selectedVideoIds(),
    });
    if (!built.ok) {
      wx.showToast({ title: '尚未加载完成，请稍后重试', icon: 'none' });
      return;
    }
    shopAdmin(built.data)
      .then((res) => {
        this.setData({ id: res.id });
        wx.showToast({ title: '已保存' });
      })
      .catch((err) => wx.showToast({ title: err.message || '保存失败', icon: 'none' }));
  },
});
