const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildDraftPayload, buildImportPlan } = require('./importPlan');

function readyEntry(overrides = {}) {
  return {
    sourceKey: 'abc123',
    title: '南方点测量',
    brandName: '南方',
    intro: '第一步连接仪器，第二步开始测量。',
    introStatus: 'reviewed',
    tags: ['点测量'],
    modelName: '',
    durationSec: 12.5,
    media: { videoCodec: 'h264', audioCodec: 'aac', hasAudio: true },
    prepared: {
      media: 'media/abc123.mp4',
      cover: 'covers/abc123.jpg',
    },
    transcriptSegments: [
      { startSec: 0, endSec: 2.5, text: '连接仪器' },
      { startSec: 2.5, endSec: 5, text: '开始测量' },
    ],
    transcription: { status: 'ready', model: 'medium', language: 'zh' },
    ...overrides,
  };
}

function preparedFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-import-plan-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'media'));
  fs.mkdirSync(path.join(directory, 'covers'));
  fs.writeFileSync(path.join(directory, 'media/abc123.mp4'), 'video');
  fs.writeFileSync(path.join(directory, 'covers/abc123.jpg'), 'cover');
  return directory;
}

test('字幕 ready 但介绍未 reviewed 时拒绝导入', (t) => {
  const manifestDirectory = preparedFixture(t);
  const plan = buildImportPlan({
    entries: [readyEntry({ introStatus: 'needs_review' })],
    manifestDirectory,
  });

  assert.equal(plan.ready.length, 0);
  assert.equal(plan.rejected.length, 1);
  assert.deepEqual(plan.rejected[0].issues, ['INTRO_NOT_REVIEWED']);
});

test('字幕未 ready 时拒绝导入', (t) => {
  const manifestDirectory = preparedFixture(t);
  const plan = buildImportPlan({
    entries: [readyEntry({ transcription: { status: 'failed' } })],
    manifestDirectory,
  });

  assert.deepEqual(plan.rejected[0].issues, ['TRANSCRIPTION_NOT_READY']);
});

test('缺少封面文件时拒绝导入', (t) => {
  const manifestDirectory = preparedFixture(t);
  fs.rmSync(path.join(manifestDirectory, 'covers/abc123.jpg'));

  const plan = buildImportPlan({
    entries: [readyEntry()],
    manifestDirectory,
  });

  assert.deepEqual(plan.rejected[0].issues, ['COVER_FILE_MISSING']);
});

test('缺少媒体文件时拒绝导入', (t) => {
  const manifestDirectory = preparedFixture(t);
  fs.rmSync(path.join(manifestDirectory, 'media/abc123.mp4'));

  const plan = buildImportPlan({
    entries: [readyEntry()],
    manifestDirectory,
  });

  assert.deepEqual(plan.rejected[0].issues, ['MEDIA_FILE_MISSING']);
});

test('草稿 payload 只含允许字段且知识派生字段明确留空', () => {
  const payload = buildDraftPayload(readyEntry(), {
    brandId: 'brand-1',
    coverFileId: 'cloud://cover',
    videoFileId: 'cloud://video',
  });

  assert.deepEqual(Object.keys(payload).sort(), [
    'brandId',
    'coverFileId',
    'durationSec',
    'entities',
    'intro',
    'media',
    'modelName',
    'searchAbstract',
    'tags',
    'title',
    'transcriptSegments',
    'videoFileId',
  ]);
  assert.equal(payload.searchAbstract, '');
  assert.deepEqual(payload.entities, {
    models: [],
    actions: [],
    menus: [],
    aliases: [],
  });
  assert.deepEqual(payload.transcriptSegments, readyEntry().transcriptSegments);
  assert.equal(Object.hasOwn(payload, 'transcript'), false);
  assert.equal(Object.hasOwn(payload, 'status'), false);
});

test('导入计划不产生 publishVideo action', (t) => {
  const manifestDirectory = preparedFixture(t);
  const plan = buildImportPlan({
    entries: [readyEntry()],
    manifestDirectory,
  });

  assert.deepEqual(
    plan.ready[0].actions.map((action) => action.type),
    ['uploadCover', 'uploadVideo', 'upsertVideo'],
  );
  assert.equal(JSON.stringify(plan).includes('publishVideo'), false);
});

test('已成功条目幂等跳过', (t) => {
  const manifestDirectory = preparedFixture(t);
  const plan = buildImportPlan({
    entries: [
      readyEntry({
        import: {
          status: 'success',
          cover: { status: 'success', fileId: 'cloud://cover' },
          video: { status: 'success', fileId: 'cloud://video' },
          draft: { status: 'success', videoId: 'video-1' },
        },
      }),
    ],
    manifestDirectory,
  });

  assert.equal(plan.ready.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].reason, 'ALREADY_IMPORTED');
});

test('已成功 checkpoint 不重复规划上传', (t) => {
  const manifestDirectory = preparedFixture(t);
  const plan = buildImportPlan({
    entries: [
      readyEntry({
        import: {
          status: 'pending',
          cover: { status: 'success', fileId: 'cloud://cover' },
        },
      }),
    ],
    manifestDirectory,
  });

  assert.deepEqual(
    plan.ready[0].actions.map((action) => action.type),
    ['uploadVideo', 'upsertVideo'],
  );
});

test('空品牌名变成清晰 rejected 而不影响同批合法条目', (t) => {
  const manifestDirectory = preparedFixture(t);
  const plan = buildImportPlan({
    entries: [readyEntry({ brandName: '  ' }), readyEntry({ sourceKey: 'valid' })],
    manifestDirectory,
  });

  assert.equal(plan.ready.length, 1);
  assert.deepEqual(plan.rejected[0].issues, ['BRAND_NAME_REQUIRED']);
});

test('空介绍变成清晰 rejected', (t) => {
  const manifestDirectory = preparedFixture(t);
  const plan = buildImportPlan({
    entries: [readyEntry({ intro: '  ' })],
    manifestDirectory,
  });

  assert.deepEqual(plan.rejected[0].issues, ['INTRO_REQUIRED']);
});

test('非数组 tags 变成清晰 rejected', (t) => {
  const manifestDirectory = preparedFixture(t);
  const plan = buildImportPlan({
    entries: [readyEntry({ tags: '点测量' })],
    manifestDirectory,
  });

  assert.deepEqual(plan.rejected[0].issues, ['TAGS_INVALID']);
});

test('空 transcriptSegments 变成清晰 rejected', (t) => {
  const manifestDirectory = preparedFixture(t);
  const plan = buildImportPlan({
    entries: [readyEntry({ transcriptSegments: [] })],
    manifestDirectory,
  });

  assert.deepEqual(plan.rejected[0].issues, ['TRANSCRIPT_SEGMENTS_REQUIRED']);
});

test('非法 transcript segment 变成清晰 rejected', (t) => {
  const manifestDirectory = preparedFixture(t);
  const plan = buildImportPlan({
    entries: [
      readyEntry({
        transcriptSegments: [{ startSec: 3, endSec: 2, text: '' }],
      }),
    ],
    manifestDirectory,
  });

  assert.deepEqual(plan.rejected[0].issues, ['TRANSCRIPT_SEGMENT_INVALID']);
});

test('已有 draft videoId 的重试 payload 带 id', () => {
  const payload = buildDraftPayload(
    readyEntry({
      import: {
        draft: { status: 'failed', videoId: 'video-existing' },
      },
    }),
    {
      brandId: 'brand-1',
      coverFileId: 'cloud://cover',
      videoFileId: 'cloud://video',
      videoId: 'video-existing',
    },
  );

  assert.equal(payload.id, 'video-existing');
});
