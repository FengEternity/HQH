const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildDraftPayload, buildImportPlan } = require('./importPlan');

const PREPARED_MEDIA_SHA256 = crypto
  .createHash('sha256')
  .update('video')
  .digest('hex');

function playbackMetadata(overrides = {}) {
  return {
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
    compliant: true,
    ...overrides,
  };
}

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
    media: {
      videoCodec: 'h264',
      audioCodec: 'aac',
      hasAudio: true,
      playback: playbackMetadata(),
    },
    prepared: {
      media: 'media/abc123.mp4',
      mediaSha256: PREPARED_MEDIA_SHA256,
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

test('草稿 payload 的 tags 去空白并去重，dry-run 与云端存储结果一致', (t) => {
  const manifestDirectory = preparedFixture(t);
  const entry = readyEntry({ tags: [' 点测量 ', '点测量', '放样', '放样 '] });

  const payload = buildDraftPayload(entry, {
    brandId: 'brand-1',
    coverFileId: 'cloud://cover',
    videoFileId: 'cloud://video',
  });
  assert.deepEqual(payload.tags, ['点测量', '放样']);

  const plan = buildImportPlan({ entries: [entry], manifestDirectory });
  assert.deepEqual(plan.ready[0].draftPayload.tags, ['点测量', '放样']);
  assert.deepEqual(entry.tags, [' 点测量 ', '点测量', '放样', '放样 ']);
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

test('空标题变成清晰 rejected', (t) => {
  const manifestDirectory = preparedFixture(t);
  const plan = buildImportPlan({
    entries: [readyEntry({ title: '  ' })],
    manifestDirectory,
  });

  assert.deepEqual(plan.rejected[0].issues, ['TITLE_REQUIRED']);
});

test('非法 durationSec 变成清晰 rejected', (t) => {
  const manifestDirectory = preparedFixture(t);

  for (const durationSec of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, '12']) {
    const plan = buildImportPlan({
      entries: [readyEntry({ durationSec })],
      manifestDirectory,
    });
    assert.deepEqual(plan.rejected[0].issues, ['DURATION_INVALID']);
  }
});

test('media 非对象变成清晰 rejected', (t) => {
  const manifestDirectory = preparedFixture(t);

  for (const media of [null, [], 'h264']) {
    const plan = buildImportPlan({
      entries: [readyEntry({ media })],
      manifestDirectory,
    });
    assert.deepEqual(plan.rejected[0].issues, ['MEDIA_INVALID']);
  }
});

test('media 出现额外字段变成清晰 rejected', (t) => {
  const manifestDirectory = preparedFixture(t);
  const plan = buildImportPlan({
    entries: [
      readyEntry({
        media: {
          videoCodec: 'h264',
          audioCodec: 'aac',
          hasAudio: true,
          playback: playbackMetadata(),
          width: 1280,
        },
      }),
    ],
    manifestDirectory,
  });

  assert.deepEqual(plan.rejected[0].issues, ['MEDIA_FIELDS_INVALID']);
});

test('media codec 非字符串变成对应 rejected', (t) => {
  const manifestDirectory = preparedFixture(t);
  const videoPlan = buildImportPlan({
    entries: [
      readyEntry({
        media: {
          videoCodec: 264,
          audioCodec: 'aac',
          hasAudio: true,
          playback: playbackMetadata(),
        },
      }),
    ],
    manifestDirectory,
  });
  const audioPlan = buildImportPlan({
    entries: [
      readyEntry({
        media: {
          videoCodec: 'h264',
          audioCodec: null,
          hasAudio: true,
          playback: playbackMetadata(),
        },
      }),
    ],
    manifestDirectory,
  });

  assert.deepEqual(videoPlan.rejected[0].issues, ['VIDEO_CODEC_INVALID']);
  assert.deepEqual(audioPlan.rejected[0].issues, ['AUDIO_CODEC_INVALID']);
});

test('media hasAudio 非布尔变成清晰 rejected', (t) => {
  const manifestDirectory = preparedFixture(t);
  const plan = buildImportPlan({
    entries: [
      readyEntry({
        media: {
          videoCodec: 'h264',
          audioCodec: 'aac',
          hasAudio: 1,
          playback: playbackMetadata(),
        },
      }),
    ],
    manifestDirectory,
  });

  assert.deepEqual(plan.rejected[0].issues, ['HAS_AUDIO_INVALID']);
});

test('缺少 playback 检查结果时拒绝导入', (t) => {
  const manifestDirectory = preparedFixture(t);
  const plan = buildImportPlan({
    entries: [
      readyEntry({
        media: { videoCodec: 'h264', audioCodec: 'aac', hasAudio: true },
      }),
    ],
    manifestDirectory,
  });

  assert.deepEqual(plan.rejected[0].issues, ['PLAYBACK_INVALID']);
});

test('prepared 媒体播放规格不合格时拒绝导入', (t) => {
  const manifestDirectory = preparedFixture(t);
  const plan = buildImportPlan({
    entries: [
      readyEntry({
        media: {
          videoCodec: 'h264',
          audioCodec: 'aac',
          hasAudio: true,
          playback: playbackMetadata({
            maxKeyframeGapSec: 10,
            compliant: false,
          }),
        },
      }),
    ],
    manifestDirectory,
  });

  assert.deepEqual(plan.rejected[0].issues, ['PLAYBACK_NOT_COMPLIANT']);
});

test('prepared 媒体内容与播放检查绑定哈希不一致时拒绝导入', (t) => {
  const manifestDirectory = preparedFixture(t);
  fs.writeFileSync(
    path.join(manifestDirectory, 'media/abc123.mp4'),
    'replaced-video',
  );

  const plan = buildImportPlan({
    entries: [readyEntry()],
    manifestDirectory,
  });

  assert.deepEqual(plan.rejected[0].issues, ['PLAYBACK_MEDIA_MISMATCH']);
});

test('无 videoId 的 inflight 草稿拒绝自动重试', (t) => {
  const manifestDirectory = preparedFixture(t);
  const plan = buildImportPlan({
    entries: [
      readyEntry({
        import: {
          status: 'failed',
          cover: { status: 'success', fileId: 'cloud://cover' },
          video: { status: 'success', fileId: 'cloud://video' },
          draft: { status: 'inflight' },
        },
      }),
    ],
    manifestDirectory,
  });

  assert.equal(plan.ready.length, 0);
  assert.deepEqual(plan.rejected[0].issues, ['DRAFT_INFLIGHT_REQUIRES_REVIEW']);
});

test('有 videoId 的 inflight 草稿允许幂等更新', (t) => {
  const manifestDirectory = preparedFixture(t);
  const plan = buildImportPlan({
    entries: [
      readyEntry({
        import: {
          status: 'failed',
          cover: { status: 'success', fileId: 'cloud://cover' },
          video: { status: 'success', fileId: 'cloud://video' },
          draft: { status: 'inflight', videoId: 'video-existing' },
        },
      }),
    ],
    manifestDirectory,
  });

  assert.deepEqual(
    plan.ready[0].actions.map((action) => action.type),
    ['upsertVideo'],
  );
  assert.equal(plan.ready[0].draftPayload.id, 'video-existing');
});

test('tags 含非空字符串以外元素时 rejected', (t) => {
  const manifestDirectory = preparedFixture(t);

  for (const tags of [['点测量', {}], ['点测量', '  ']]) {
    const plan = buildImportPlan({
      entries: [readyEntry({ tags })],
      manifestDirectory,
    });
    assert.deepEqual(plan.rejected[0].issues, ['TAG_ELEMENTS_INVALID']);
  }
});

test('modelName 非字符串时 rejected', (t) => {
  const manifestDirectory = preparedFixture(t);
  const plan = buildImportPlan({
    entries: [readyEntry({ modelName: { name: 'C10' } })],
    manifestDirectory,
  });

  assert.deepEqual(plan.rejected[0].issues, ['MODEL_NAME_INVALID']);
});

test('字幕结束秒超过时长时 rejected', (t) => {
  const manifestDirectory = preparedFixture(t);
  const plan = buildImportPlan({
    entries: [
      readyEntry({
        durationSec: 5,
        transcriptSegments: [
          { startSec: 0, endSec: 2.5, text: '连接仪器' },
          { startSec: 2.5, endSec: 5.1, text: '开始测量' },
        ],
      }),
    ],
    manifestDirectory,
  });

  assert.deepEqual(plan.rejected[0].issues, ['TRANSCRIPT_SEGMENT_OUT_OF_RANGE']);
});

test('字幕结束秒正好等于时长时仍可导入', (t) => {
  const manifestDirectory = preparedFixture(t);
  const plan = buildImportPlan({
    entries: [
      readyEntry({
        durationSec: 5,
        transcriptSegments: [{ startSec: 0, endSec: 5, text: '连接仪器' }],
      }),
    ],
    manifestDirectory,
  });

  assert.equal(plan.rejected.length, 0);
  assert.equal(plan.ready.length, 1);
});

test('prepared 文件是指向目录外的符号链接时 rejected', (t) => {
  const manifestDirectory = preparedFixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-import-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const secret = path.join(outside, 'secret.mp4');
  fs.writeFileSync(secret, 'outside-payload');

  const linked = path.join(manifestDirectory, 'media/abc123.mp4');
  fs.rmSync(linked);
  fs.symlinkSync(secret, linked);

  const plan = buildImportPlan({
    entries: [readyEntry()],
    manifestDirectory,
  });

  assert.deepEqual(plan.rejected[0].issues, ['MEDIA_FILE_MISSING']);
});

test('prepared 目录本身是符号链接时不误判为逃逸', (t) => {
  const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-import-real-'));
  t.after(() => fs.rmSync(realRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(realRoot, 'media'));
  fs.mkdirSync(path.join(realRoot, 'covers'));
  fs.writeFileSync(path.join(realRoot, 'media/abc123.mp4'), 'video');
  fs.writeFileSync(path.join(realRoot, 'covers/abc123.jpg'), 'cover');

  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-import-link-'));
  t.after(() => fs.rmSync(linkParent, { recursive: true, force: true }));
  const manifestDirectory = path.join(linkParent, 'prepared');
  fs.symlinkSync(realRoot, manifestDirectory);

  const plan = buildImportPlan({
    entries: [readyEntry()],
    manifestDirectory,
  });

  assert.equal(plan.rejected.length, 0);
  assert.equal(plan.ready.length, 1);
});
