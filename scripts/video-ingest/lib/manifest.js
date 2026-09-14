const crypto = require('node:crypto');
const path = require('node:path');

// 该副本与正片字节不同，无法依靠内容哈希去重，但业务规则只保留正片。
const EXCLUDED_TITLES = new Set(['中海达主机固件升级_副本']);

function normalizeTitle(fileName) {
  return path.basename(fileName, path.extname(fileName)).trim();
}

function assignBrand(relativePath, title) {
  for (const brand of ['中海达', '南方', '司南']) {
    if (title.startsWith(brand)) {
      return brand;
    }
  }

  const [directory = ''] = relativePath.split('/');
  return ['中海达', '南方', '司南'].includes(directory) ? directory : '';
}

function isExplicitlyExcluded(file) {
  return EXCLUDED_TITLES.has(normalizeTitle(file.relativePath));
}

function preferOriginal(left, right) {
  const leftIsCopy = normalizeTitle(left.relativePath).endsWith('_副本');
  const rightIsCopy = normalizeTitle(right.relativePath).endsWith('_副本');
  if (leftIsCopy !== rightIsCopy) {
    return leftIsCopy ? right : left;
  }
  return left.relativePath.localeCompare(right.relativePath, 'zh-CN') <= 0 ? left : right;
}

function selectCandidates(files) {
  const byHash = new Map();

  for (const file of files) {
    if (isExplicitlyExcluded(file)) {
      continue;
    }
    const existing = byHash.get(file.sha256);
    byHash.set(file.sha256, existing ? preferOriginal(existing, file) : file);
  }

  return [...byHash.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, 'zh-CN'),
  );
}

function buildManifestEntry(file, probe, content) {
  const sourceRelativePath = file.relativePath.split(path.sep).join('/');
  const title = normalizeTitle(sourceRelativePath);
  const draft = content[title];
  if (!draft) {
    throw new Error(`缺少运营草案：${title}`);
  }

  const sourceKey = crypto.createHash('sha256').update(sourceRelativePath).digest('hex');
  const slug = sourceKey.slice(0, 16);
  const videoCodec = probe.videoCodec.toLowerCase();
  const audioCodec = probe.audioCodec.toLowerCase();
  const transcodeRequired =
    videoCodec !== 'h264' || (probe.hasAudio && audioCodec !== 'aac');

  return {
    sourceKey,
    sourceRelativePath,
    sourceSha256: file.sha256,
    title,
    brandName: assignBrand(sourceRelativePath, title),
    tags: [...draft.tags],
    intro: draft.intro,
    modelName: draft.modelName || '',
    durationSec: Math.round(probe.durationSec * 10) / 10,
    media: {
      videoCodec: 'h264',
      audioCodec: probe.hasAudio ? 'aac' : '',
      hasAudio: probe.hasAudio,
    },
    sourceMedia: {
      videoCodec: probe.videoCodec,
      audioCodec: probe.audioCodec,
    },
    transcodeRequired,
    prepared: {
      media: `media/${slug}.mp4`,
      cover: `covers/${slug}.jpg`,
      keyframes: `keyframes/${slug}`,
    },
    status: 'prepared',
  };
}

module.exports = {
  assignBrand,
  buildManifestEntry,
  normalizeTitle,
  selectCandidates,
};
