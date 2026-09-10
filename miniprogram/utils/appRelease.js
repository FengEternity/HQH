'use strict';

function asNotes(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string');
}

function envLabel(envVersion) {
  if (envVersion === 'develop') return '开发版';
  if (envVersion === 'trial') return '体验版';
  if (envVersion === 'release') return '正式版';
  return '未知环境';
}

function normalizeRelease(item) {
  if (!item || typeof item !== 'object') return null;
  return {
    version: typeof item.version === 'string' ? item.version : '',
    date: typeof item.date === 'string' ? item.date : '',
    user: asNotes(item.user),
    internal: asNotes(item.internal),
  };
}

function normalizeDoc(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { version: '未知', releases: [] };
  }
  const version =
    typeof raw.version === 'string' && raw.version.trim()
      ? raw.version.trim()
      : '未知';
  const list = Array.isArray(raw.releases) ? raw.releases : [];
  const releases = [];
  for (let i = 0; i < list.length; i++) {
    const row = normalizeRelease(list[i]);
    if (row) releases.push(row);
  }
  return { version, releases };
}

function visibleReleases(releases, staff) {
  const list = Array.isArray(releases) ? releases : [];
  if (staff) return list;
  return list
    .filter((row) => row.user.length > 0)
    .map((row) => ({
      version: row.version,
      date: row.date,
      user: row.user,
      internal: [],
    }));
}

function wxVersionLine(staff, wxVersion) {
  if (!staff) return '';
  if (wxVersion) return '微信版本 ' + wxVersion;
  return '微信后台版本号仅正式版可见';
}

function clipboardText(opts) {
  const version = opts.version;
  const label = opts.envLabel;
  const staff = opts.staff;
  const wxVersion = opts.wxVersion;
  let text = '优度 ' + version + ' · ' + label;
  if (staff && wxVersion) text += ' · 微信 ' + wxVersion;
  return text;
}

function isStaffMode(query) {
  return !!(query && query.staff === '1');
}

function buildAboutView(input) {
  const staff = !!input.staff;
  const normalized = normalizeDoc(input.doc);
  const mini = (input.accountInfo && input.accountInfo.miniProgram) || {};
  const wxVersion = typeof mini.version === 'string' ? mini.version.trim() : '';
  const releases = visibleReleases(normalized.releases, staff).map((row) => ({
    version: row.version,
    date: row.date,
    user: row.user,
    internal: staff ? row.internal : [],
  }));
  return {
    productName: '优度 · 仪器讲解',
    version: normalized.version,
    envLabel: envLabel(mini.envVersion),
    wxVersion: wxVersion,
    showWxRow: staff,
    wxLine: wxVersionLine(staff, wxVersion),
    releases: releases,
    emptyHint: !staff && releases.length === 0 ? '暂无面向用户的更新说明' : '',
  };
}

module.exports = {
  envLabel,
  normalizeDoc,
  visibleReleases,
  wxVersionLine,
  clipboardText,
  isStaffMode,
  buildAboutView,
};
