'use strict';

const PLACEHOLDER_INTRO = '讲解处理中，完成后请核对简介。';
const MINUTE_MS = 60 * 1000;
const INTRO_WAIT_BASE_MS = 8 * MINUTE_MS;
const INTRO_WAIT_MIN_MS = 15 * MINUTE_MS;
const INTRO_WAIT_MAX_MS = 30 * MINUTE_MS;
const INTRO_WAIT_ABSOLUTE_MS = 45 * MINUTE_MS;

function introWaitMs(durationSec) {
  const duration = Number(durationSec);
  const scaled = Number.isFinite(duration) && duration > 0
    ? INTRO_WAIT_BASE_MS + duration * 1000 * 2
    : INTRO_WAIT_MIN_MS;
  const bounded = Math.min(
    INTRO_WAIT_MAX_MS,
    Math.max(INTRO_WAIT_MIN_MS, scaled),
  );
  return Math.min(bounded, INTRO_WAIT_ABSOLUTE_MS);
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hasIntroCopy(value) {
  const text = cleanText(value);
  return Boolean(text) && text !== PLACEHOLDER_INTRO;
}

function resolveIntroReview(doc) {
  const review = doc && doc.introReview;
  if (review === 'pending' || review === 'confirmed') {
    return review;
  }
  const intro = cleanText(doc && doc.intro);
  if (intro && intro !== PLACEHOLDER_INTRO) {
    return 'confirmed';
  }
  return 'pending';
}

function gateReasonText(reason) {
  const raw = typeof reason === 'string' ? reason : '';
  if (raw.startsWith('term ')) {
    return `${raw.slice(5)}未在口播里出现`;
  }
  if (raw.startsWith('length ')) {
    return '字数不合要求';
  }
  if (raw.startsWith('sentences ')) {
    return '不成句';
  }
  if (raw.startsWith('banned ')) {
    return '含有不应出现的套话';
  }
  if (raw === 'placeholder' || raw.startsWith('placeholder ')) {
    return '仍是占位句';
  }
  if (raw === 'brand' || raw.startsWith('brand ')) {
    return '未写明本片品牌';
  }
  if (raw.startsWith('other-brand ')) {
    return '写了别的品牌';
  }
  if (raw.startsWith('format ')) {
    return '出现了口播里没有的格式';
  }
  if (raw.startsWith('capability ')) {
    return '出现了口播里没有的连接方式';
  }
  return '未通过检查';
}

function ingestStamp(ingest) {
  const queuedAt = Number(ingest && ingest.queuedAt) || 0;
  const startedAt = Number(ingest && ingest.startedAt) || 0;
  return queuedAt || startedAt || 0;
}

function introWaitExceeded(ingest, now, durationSec) {
  const stamp = ingestStamp(ingest);
  if (!stamp) {
    return false;
  }
  return Number(now) - stamp >= introWaitMs(durationSec);
}

function hasAnyIntro(video) {
  const source = video && typeof video === 'object' ? video : {};
  return hasIntroCopy(source.autoIntro)
    || hasIntroCopy(source.humanIntro)
    || hasIntroCopy(source.intro);
}

function pendingIntroHint({ autoIntro, humanIntro, intro, introReview, introGate, phase }) {
  if (!hasIntroCopy(autoIntro) || hasIntroCopy(humanIntro)) {
    return '';
  }
  if (resolveIntroReview({ intro, introReview }) !== 'pending') {
    return '';
  }
  const busy = phase === 'queued' || phase === 'running';
  const passed = !introGate || introGate.ok !== false;
  const base = passed
    ? '自动简介已填入，请核对。保存后才能上架。'
    : `自动简介已填入，但未通过检查（${gateReasonText(introGate.reason)}）。请核对修改，保存后才能上架。`;
  return busy ? `${base}播放文件仍在处理` : base;
}

function emptyIntroHint({ autoIntro, humanIntro, phase, ingest, now, durationSec }) {
  if (hasIntroCopy(autoIntro) || hasIntroCopy(humanIntro)) {
    return '';
  }
  if ((phase === 'queued' || phase === 'running') && introWaitExceeded(ingest, now, durationSec)) {
    return '处理时间较长，可先手写简介。自动稿出来后留在对照里，不会盖掉你写的。';
  }
  if (phase === 'ready' || phase === 'failed') {
    return '没有生成简介，请手写后再保存上架。';
  }
  return '';
}

function gateFailureNote(humanIntro, autoIntro, introGate) {
  if (!hasIntroCopy(humanIntro) || !hasIntroCopy(autoIntro) || humanIntro === autoIntro) {
    return '';
  }
  if (!introGate || introGate.ok !== false) {
    return '';
  }
  return `未通过检查（${gateReasonText(introGate.reason)}）`;
}

function listIngestLabel(video, now = Date.now()) {
  const source = video && typeof video === 'object' ? video : {};
  const ingest = source.ingest && typeof source.ingest === 'object' ? source.ingest : {};
  const phase = ingest.phase || 'idle';
  const asr = ingest.asr || 'pending';
  if ((phase === 'queued' || phase === 'running') && !hasAnyIntro(source) && introWaitExceeded(ingest, now, source.durationSec)) {
    return '可先手写';
  }
  if (phase === 'queued') {
    return '排队';
  }
  if (phase === 'running') {
    return '正在转';
  }
  if (phase === 'failed') {
    return '失败';
  }
  if (phase === 'ready' && resolveIntroReview(source) === 'pending') {
    return '待确认';
  }
  if (phase === 'ready' && asr === 'skipped') {
    return '无音轨';
  }
  if (phase === 'ready') {
    return '待核对';
  }
  return '';
}

module.exports = {
  introWaitMs,
  gateFailureNote,
  gateReasonText,
  emptyIntroHint,
  listIngestLabel,
  pendingIntroHint,
  resolveIntroReview,
};
