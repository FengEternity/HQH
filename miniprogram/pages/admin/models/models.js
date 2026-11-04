const { agent } = require('../../../utils/api');

function viewPlaces(places, modelIds, notes) {
  return (places || []).map((place) => {
    const note = notes && notes[place.id];
    return {
      id: place.id,
      label: place.label,
      hint: place.hint || '',
      model: place.model,
      modelIndex: Math.max(0, modelIds.indexOf(place.model)),
      note: (note && note.text) || '',
      noteOk: Boolean(note && note.ok),
    };
  });
}

Page({
  data: {
    modelIds: [],
    places: [],
    error: '',
    connectionReady: false,
    connectionText: '正在检查模型服务…',
  },
  onShow() {
    return this.load();
  },
  load() {
    return agent({ action: 'agentModelConfig' })
      .then((result) => {
        this.places = (result && result.places) || [];
        this.modelIds = ((result && result.models) || []).map((item) => item && item.id).filter(Boolean);
        this.notes = {};
        this.paint();
        const ready = Boolean(result.connection && result.connection.ready);
        this.setData({ error: '', connectionReady: ready,
          connectionText: ready ? '问答服务已配置 TokenHub，可测试模型连通性' : '问答服务尚未就绪，请由部署人员完成服务端接入设置',
        });
      })
      .catch((err) => this.fail(err, '加载失败'));
  },
  paint() {
    this.setData({
      modelIds: this.modelIds,
      places: viewPlaces(this.places, this.modelIds, this.notes),
    });
  },
  onPick(event) {
    const placeId = event.currentTarget.dataset.place;
    const modelId = this.modelIds[Number(event.detail.value)];
    if (!modelId) return;
    return agent({ action: 'agentModelSave', place: placeId, model: modelId })
      .then((result) => {
        this.places = (result && result.places) || this.places;
        delete this.notes[placeId];
        this.paint();
      })
      .catch((err) => this.fail(err, '切换失败'));
  },
  testModel(event) {
    const placeId = event.currentTarget.dataset.place;
    if (!this.data.connectionReady && placeId !== 'video_intro') {
      this.setData({ error: '模型服务尚未就绪，请先完成服务端接入设置' });
      return Promise.resolve();
    }
    const place = (this.places || []).find((item) => item.id === placeId);
    if (!place) return;
    const testedModel = place.model;
    this.notes[placeId] = { text: '正在测试…', ok: true };
    this.paint();
    return agent({ action: 'agentModelTest', place: placeId, model: place.model })
      .then((result) => {
        if (!(this.places || []).some(item => item.id === placeId && item.model === testedModel)) return;
        const text = result && result.text ? '：' + result.text : '';
        this.notes[placeId] = {
          text: ((result && result.message) || '可以调用') + text,
          ok: true,
        };
        this.paint();
      })
      .catch((err) => {
        if (!(this.places || []).some(item => item.id === placeId && item.model === testedModel)) return;
        if (err && err.code === 'UNAUTHORIZED') {
          this.fail(err, '未授权');
          return;
        }
        this.notes[placeId] = {
          text: (err && err.message) || '暂时无法调用，请稍后再试',
          ok: false,
        };
        this.paint();
      });
  },
  fail(err, fallback) {
    if (err && err.code === 'UNAUTHORIZED') {
      wx.redirectTo({ url: '/pages/admin/login/login' });
      return;
    }
    this.setData({ error: (err && err.message) || fallback });
  },
});
