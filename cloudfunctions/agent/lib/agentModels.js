'use strict';

const DEFAULT_MODEL = 'hy3';

const MODELS = [
  { id: 'hy3' },
  { id: 'hy4-preview' },
  { id: 'deepseek-v4.1-flash-1017' },
  { id: 'deepseek-v4.1-flash' },
  { id: 'deepseek/deepseek-flash' },
  { id: 'deepseek-v4-pro' },
  { id: 'deepseek-v4-pro-0813' },
  { id: 'glm-5.3-flashx' },
  { id: 'glm-5.3-flash' },
  { id: 'glm-5.3' },
  { id: 'glm-5.2' },
  { id: 'kimi-k3' },
  { id: 'kimi-k2.8-preview' },
  { id: 'kimi-k2.7-code-highspeed' },
  { id: 'kimi-k2.7-code' },
  { id: 'kimi-k2.6' },
  { id: 'minimax-m3' },
  { id: 'mimo-v2.6-pro' },
  { id: 'mimo-v2.6-flash' },
  { id: 'step-5-preview' },
];

const PLACES = [
  { id: 'video_doc', label: '播放页问答', hint: '讲解页提问时使用' },
  { id: 'customer_service', label: '客服', hint: '已保存，客服回复接入后按这个名字调用' },
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
  const saved = clean(stored && stored[place]);
  if (isListedModel(saved)) return saved;
  const fromEnv = clean(env && env.AGENT_MODEL_NAME);
  if (isListedModel(fromEnv)) return fromEnv;
  return DEFAULT_MODEL;
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

function assignmentPatch(current, place, model) {
  if (!knownPlace(place) || !isListedModel(model)) throw coded('BAD_INPUT');
  const next = {};
  PLACES.forEach((item) => {
    const existing = clean(current && current[item.id]);
    next[item.id] = isListedModel(existing) ? existing : DEFAULT_MODEL;
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
