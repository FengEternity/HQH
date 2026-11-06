'use strict';

const DEFAULT_MODEL = 'hy3';
const { TEXT_MODELS, resolveTextModel } = require('./ai-runtime');
const MODELS = TEXT_MODELS.map(id => ({ id }));

const PLACES = [
  { id: 'video_doc', label: '播放页问答', hint: '讲解页提问时使用' },
  { id: 'customer_service', label: '客服', hint: '已保存，客服回复接入后按这个名字调用' },
  { id: 'video_intro', label: '视频简介', hint: '处理成片时写简介使用' },
];

function clean(value) {
  return String(value || '').trim();
}

function isListedModel(id) {
  return MODELS.some((item) => item.id === id);
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function knownPlace(place) {
  return PLACES.some((item) => item.id === place);
}

function resolvePlaceModel({ place, stored, env }) {
  if (!knownPlace(place)) throw coded('BAD_INPUT');
  return resolveTextModel({ place, stored, env: env || {} });
}

function publicModelConfig(stored, env) {
  return {
    models: MODELS.map((item) => ({ id: item.id })),
    places: PLACES.map((item) => ({
      id: item.id,
      label: item.label,
      hint: item.hint,
      model: resolvePlaceModel({ place: item.id, stored, env }),
    })),
  };
}

function assignmentPatch(current, place, model, env = {}) {
  if (!knownPlace(place) || !isListedModel(model)) throw coded('BAD_INPUT');
  const next = {};
  PLACES.forEach((item) => {
    const existing = clean(current && current[item.id]);
    next[item.id] = isListedModel(existing) ? existing : resolvePlaceModel({ place: item.id, stored: current, env });
  });
  next[place] = model;
  return next;
}

module.exports = {
  DEFAULT_MODEL,
  MODELS,
  PLACES,
  isListedModel,
  resolvePlaceModel,
  publicModelConfig,
  assignmentPatch,
};
