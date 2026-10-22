const { admin } = require('../../../utils/api');

function showActionSheet(itemList) {
  return new Promise((resolve) => {
    wx.showActionSheet({
      itemList,
      success: resolve,
      fail: () => resolve(null),
    });
  });
}

function confirmDisable() {
  return new Promise((resolve) => {
    wx.showModal({
      title: '停用人员',
      content: '停用后，此人将不能进入运营工作台。',
      confirmText: '停用',
      confirmColor: '#b42318',
      success: (result) => resolve(Boolean(result.confirm)),
      fail: () => resolve(false),
    });
  });
}

function saveInviteImage(imageBase64) {
  const filePath = `${wx.env.USER_DATA_PATH}/admin-invite.png`;
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().writeFile({
      filePath,
      data: imageBase64,
      encoding: 'base64',
      success: resolve,
      fail: reject,
    });
  }).then(
    () =>
      new Promise((resolve, reject) => {
        wx.saveImageToPhotosAlbum({
          filePath,
          success: resolve,
          fail: reject,
        });
      }),
  );
}

function presentStaff(item) {
  return {
    ...item,
    name: item.nickname || '未设置昵称',
    roleLabel: item.role === 'admin' ? '管理员' : '运营',
    statusLabel: item.enabled ? '启用' : '已停用',
  };
}

function staffRank(item) {
  if (!item.enabled) return 2;
  return item.role === 'admin' ? 0 : 1;
}

function sortStaff(staff) {
  return staff.slice().sort((left, right) => {
    const rankDifference = staffRank(left) - staffRank(right);
    if (rankDifference !== 0) return rankDifference;
    return (left.createdAt || 0) - (right.createdAt || 0);
  });
}

Page({
  data: {
    loading: true,
    staff: [],
  },
  onShow() {
    return this.load();
  },
  load() {
    this.setData({ loading: true });
    return admin({ action: 'adminListStaff' })
      .then((result) => {
        this.setData({
          loading: false,
          staff: sortStaff((result.staff || []).map(presentStaff)),
        });
      })
      .catch((error) => {
        this.setData({ loading: false });
        this.handleError(error);
      });
  },
  async openActions(event) {
    if (this.actionBusy) return;
    const id = event.currentTarget.dataset.id;
    const target = this.data.staff.find((item) => item.id === id);
    if (!target || target.isSelf) return;

    this.actionBusy = true;
    try {
      const roleAction = target.role === 'admin' ? '设为运营' : '设为管理员';
      const statusAction = target.enabled ? '停用' : '启用';
      const selection = await showActionSheet([roleAction, statusAction]);
      if (!selection) return;
      if (selection.tapIndex === 0) {
        const role = target.role === 'admin' ? 'operator' : 'admin';
        await this.updateStaff(target, { role });
        return;
      }
      if (selection.tapIndex !== 1) return;
      if (target.enabled && !(await confirmDisable())) return;
      await this.updateStaff(target, { enabled: !target.enabled });
    } finally {
      this.actionBusy = false;
    }
  },
  updateStaff(target, changes) {
    const role = changes.role || target.role;
    const enabled =
      typeof changes.enabled === 'boolean' ? changes.enabled : target.enabled;
    return admin({
      action: 'adminUpdateStaff',
      id: target.id,
      role,
      enabled,
    })
      .then((result) => {
        const staff = sortStaff(
          this.data.staff.map((item) =>
            item.id === target.id
              ? presentStaff({
                  ...item,
                  role: result.role,
                  enabled: result.enabled,
                })
              : item,
          ),
        );
        this.setData({ staff });
      })
      .catch((error) => {
        this.handleError(error);
      });
  },
  async createInvite() {
    if (this.actionBusy) return;
    this.actionBusy = true;
    try {
      const selection = await showActionSheet(['运营', '管理员']);
      if (!selection) return;
      const role = selection.tapIndex === 1 ? 'admin' : 'operator';
      try {
        const result = await admin({ action: 'adminCreateInvite', role });
        if (!result.generated) {
          wx.showToast({ title: '发布后才能生成小程序码', icon: 'none' });
          return;
        }
        try {
          await saveInviteImage(result.imageBase64);
        } catch (error) {
          wx.showToast({ title: '保存失败', icon: 'none' });
        }
      } catch (error) {
        this.handleError(error);
      }
    } finally {
      this.actionBusy = false;
    }
  },
  handleError(error) {
    if (error && error.code === 'UNAUTHORIZED') {
      wx.switchTab({ url: '/pages/mine/mine' });
      return;
    }
    if (error && error.code === 'FORBIDDEN') {
      wx.showToast({ title: '只有管理员能修改人员', icon: 'none' });
      wx.navigateBack();
      return;
    }
    const messages = {
      LAST_ADMIN: '至少保留一名管理员',
      CANNOT_EDIT_SELF: '不能修改自己',
    };
    wx.showToast({
      title: messages[error && error.code] || (error && error.message) || '操作失败',
      icon: 'none',
    });
  },
});
