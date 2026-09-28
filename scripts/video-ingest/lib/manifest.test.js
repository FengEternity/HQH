const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  assignBrand,
  buildManifestEntry,
  normalizeTitle,
  selectCandidates,
} = require('./manifest');

function playbackProbe(overrides = {}) {
  return {
    durationSec: 42,
    videoCodec: 'h264',
    profile: 'Main',
    pixelFormat: 'yuv420p',
    width: 1280,
    height: 720,
    frameRate: 30,
    hasBFrames: false,
    maxKeyframeGapSec: 2,
    fastStart: true,
    hasAudio: true,
    audioCodec: 'aac',
    ...overrides,
  };
}

test('字节哈希相同的副本只保留正片', () => {
  const selected = selectCandidates([
    { relativePath: '中海达/中海达点测量_副本.mp4', sha256: 'same-bytes' },
    { relativePath: '中海达/中海达点测量.mp4', sha256: 'same-bytes' },
  ]);

  assert.deepEqual(
    selected.map((file) => file.relativePath),
    ['中海达/中海达点测量.mp4'],
  );
});

test('主机固件升级副本即使内容不同也被规则排除', () => {
  const selected = selectCandidates([
    { relativePath: '中海达/中海达主机固件升级.mp4', sha256: 'h264' },
    { relativePath: '中海达/中海达主机固件升级_副本.mp4', sha256: 'hevc' },
  ]);

  assert.deepEqual(
    selected.map((file) => file.relativePath),
    ['中海达/中海达主机固件升级.mp4'],
  );
});

test('南方参数计算按标题归属南方而不是所在目录', () => {
  assert.equal(assignBrand('司南/南方参数计算.mp4', '南方参数计算'), '南方');
});

test('标题去扩展名并清理文件名末尾空格', () => {
  assert.equal(normalizeTitle('南方手簿有线升级 .mp4'), '南方手簿有线升级');
});

test('HEVC 条目标记为需要转码并只记录相对路径', () => {
  const entry = buildManifestEntry(
    {
      relativePath: '南方/南方数据导出.mp4',
      sha256: 'source-content-hash',
    },
    playbackProbe({
      durationSec: 42.26,
      videoCodec: 'hevc',
    }),
    {
      南方数据导出: {
        intro: '演示南方手簿数据导出。',
        tags: ['导出', '数据'],
        modelName: '',
      },
    },
  );

  assert.equal(entry.transcodeRequired, true);
  assert.equal(entry.sourceRelativePath, '南方/南方数据导出.mp4');
  assert.equal(entry.durationSec, 42.3);
  assert.deepEqual(entry.media, {
    videoCodec: 'hevc',
    audioCodec: 'aac',
    hasAudio: true,
    playback: {
      videoCodec: 'hevc',
      profile: 'Main',
      pixelFormat: 'yuv420p',
      width: 1280,
      height: 720,
      frameRate: 30,
      hasBFrames: false,
      maxKeyframeGapSec: 2,
      fastStart: true,
      hasAudio: true,
      audioCodec: 'aac',
      compliant: false,
    },
  });
  assert.equal(entry.status, 'prepared');
  assert.equal('sourcePath' in entry, false);
});

test('H.264 有音轨但非 AAC 时仍转码为 H.264 加 AAC', () => {
  const entry = buildManifestEntry(
    {
      relativePath: '南方/南方数据导出.mp4',
      sha256: 'source-content-hash',
    },
    playbackProbe({
      audioCodec: 'mp3',
    }),
    {
      南方数据导出: {
        intro: '演示南方手簿数据导出。',
        tags: ['导出', '数据'],
        modelName: '',
      },
    },
  );

  assert.equal(entry.transcodeRequired, true);
  assert.deepEqual(entry.media, {
    videoCodec: 'h264',
    audioCodec: 'mp3',
    hasAudio: true,
    playback: {
      videoCodec: 'h264',
      profile: 'Main',
      pixelFormat: 'yuv420p',
      width: 1280,
      height: 720,
      frameRate: 30,
      hasBFrames: false,
      maxKeyframeGapSec: 2,
      fastStart: true,
      hasAudio: true,
      audioCodec: 'mp3',
      compliant: false,
    },
  });
});

test('H.264 + AAC 但最大关键帧间隔 10 秒时仍标记转码', () => {
  const entry = buildManifestEntry(
    {
      relativePath: '南方/南方数据导出.mp4',
      sha256: 'source-content-hash',
    },
    playbackProbe({ maxKeyframeGapSec: 10 }),
    {
      南方数据导出: {
        intro: '演示南方手簿数据导出。',
        tags: ['导出', '数据'],
        modelName: '',
      },
    },
  );

  assert.equal(entry.transcodeRequired, true);
  assert.equal(entry.media.playback.maxKeyframeGapSec, 10);
  assert.equal(entry.media.playback.compliant, false);
});

test('无音轨媒体的 prepared audioCodec 保持为空', () => {
  const entry = buildManifestEntry(
    {
      relativePath: '南方/南方数据导出.mp4',
      sha256: 'source-content-hash',
    },
    playbackProbe({
      audioCodec: '',
      hasAudio: false,
    }),
    {
      南方数据导出: {
        intro: '演示南方手簿数据导出。',
        tags: ['导出', '数据'],
        modelName: '',
      },
    },
  );

  assert.equal(entry.transcodeRequired, false);
  assert.deepEqual(entry.media, {
    videoCodec: 'h264',
    audioCodec: '',
    hasAudio: false,
    playback: {
      videoCodec: 'h264',
      profile: 'Main',
      pixelFormat: 'yuv420p',
      width: 1280,
      height: 720,
      frameRate: 30,
      hasBFrames: false,
      maxKeyframeGapSec: 2,
      fastStart: true,
      hasAudio: false,
      audioCodec: '',
      compliant: true,
    },
  });
});

test('运营草案按规范化标题补齐 intro、tags 与 modelName', () => {
  const contentPath = path.join(__dirname, '..', 'content.zh-CN.json');
  const content = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
  const entry = buildManifestEntry(
    {
      relativePath: '南方/南方C10手簿软件升级 .mp4',
      sha256: 'source-content-hash',
    },
    playbackProbe({
      durationSec: 60,
    }),
    content,
  );

  assert.equal(entry.title, '南方C10手簿软件升级');
  assert.equal(entry.intro, '演示南方 C10 手簿软件升级。');
  assert.deepEqual(entry.tags, ['C10', '手簿', '升级']);
  assert.equal(entry.modelName, 'C10');
  assert.match(entry.sourceKey, /^[a-f0-9]{64}$/);
  assert.match(entry.prepared.media, /^media\/[a-f0-9]{16}\.mp4$/);
  assert.match(entry.prepared.cover, /^covers\/[a-f0-9]{16}\.jpg$/);
  assert.match(entry.prepared.keyframes, /^keyframes\/[a-f0-9]{16}$/);
});
