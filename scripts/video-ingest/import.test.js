const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  dryRun,
  executeImport,
  hasFailures,
  parseArguments,
  runCli,
} = require('./import');

const PREPARED_MEDIA_SHA256 = crypto
  .createHash('sha256')
  .update('video')
  .digest('hex');

function playbackMetadata() {
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
  };
}

function manifestEntry(overrides = {}) {
  return {
    sourceKey: 'abc',
    title: '南方点测量',
    brandName: '南方',
    intro: '连接仪器后开始测量。',
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
      media: 'media/abc.mp4',
      mediaSha256: PREPARED_MEDIA_SHA256,
      cover: 'covers/abc.jpg',
    },
    transcriptSegments: [{ startSec: 0, endSec: 2, text: '连接仪器' }],
    transcription: { status: 'ready' },
    ...overrides,
  };
}

function fixture(t, entries = [manifestEntry()]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-import-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'media'));
  fs.mkdirSync(path.join(directory, 'covers'));
  fs.writeFileSync(path.join(directory, 'media/abc.mp4'), 'video');
  fs.writeFileSync(path.join(directory, 'covers/abc.jpg'), 'cover');
  const manifestPath = path.join(directory, 'manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      entries,
    }),
  );
  return manifestPath;
}

function credentials() {
  return {
    env: 'env-id',
    secretId: 'secret-id',
    secretKey: 'secret-key',
    adminPin: 'admin-pin',
  };
}

test('参数默认 dry-run，只有 --execute 才执行', () => {
  assert.deepEqual(parseArguments(['--manifest', 'manifest.json']), {
    manifestPath: 'manifest.json',
    execute: false,
  });
  assert.deepEqual(parseArguments(['--manifest', 'manifest.json', '--dry-run']), {
    manifestPath: 'manifest.json',
    execute: false,
  });
  assert.deepEqual(parseArguments(['--manifest', 'manifest.json', '--execute']), {
    manifestPath: 'manifest.json',
    execute: true,
  });
  assert.throws(
    () => parseArguments(['--manifest', 'manifest.json', '--dry-run', '--execute']),
    /不能同时/,
  );
});

test('真实执行先登录和核验品牌，再上传并写入草稿 checkpoint', async (t) => {
  const manifestPath = fixture(t);
  const calls = [];
  const uploads = [];
  const app = {
    callFunction: async ({ name, data }) => {
      calls.push({ name, data });
      if (data.action === 'adminLogin') {
        return { result: { ok: true, ticket: 'ticket-1' } };
      }
      if (data.action === 'adminListBrands') {
        return { result: { ok: true, brands: [] } };
      }
      if (data.action === 'upsertBrand') {
        return { result: { ok: true, id: 'brand-1' } };
      }
      if (data.action === 'upsertVideo') {
        return { result: { ok: true, id: 'video-1' } };
      }
      throw new Error(`unexpected ${data.action}`);
    },
    uploadFile: async ({ cloudPath, fileContent }) => {
      assert.equal(typeof fileContent.pipe, 'function');
      for await (const chunk of fileContent) {
        assert.ok(chunk.length > 0);
      }
      uploads.push(cloudPath);
      return { fileID: `cloud://${cloudPath}` };
    },
  };

  const result = await executeImport({
    manifestPath,
    credentials: credentials(),
    createApp: (config) => {
      assert.deepEqual(config, {
        env: 'env-id',
        secretId: 'secret-id',
        secretKey: 'secret-key',
      });
      return app;
    },
  });

  assert.deepEqual(
    calls.map((call) => call.data.action),
    ['adminLogin', 'adminListBrands', 'upsertBrand', 'upsertVideo'],
  );
  assert.deepEqual(uploads, ['cover/abc.jpg', 'video/abc.mp4']);
  const upsert = calls.at(-1).data;
  assert.equal(upsert.ticket, 'ticket-1');
  assert.equal(upsert.brandId, 'brand-1');
  assert.equal(upsert.searchAbstract, '');
  assert.deepEqual(upsert.entities, { models: [], actions: [], menus: [], aliases: [] });
  assert.equal(Object.hasOwn(upsert, 'transcript'), false);
  assert.equal(calls.some((call) => call.data.action === 'publishVideo'), false);
  assert.equal(result.succeeded, 1);

  const saved = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(saved.entries[0].import, {
    status: 'success',
    cover: { status: 'success', fileId: 'cloud://cover/abc.jpg' },
    video: { status: 'success', fileId: 'cloud://video/abc.mp4' },
    draft: { status: 'success', videoId: 'video-1' },
  });
});

function upsertResponseApp(upsertResponse) {
  return {
    callFunction: async ({ data }) => {
      if (data.action === 'adminLogin') {
        return { result: { ok: true, ticket: 'ticket-1' } };
      }
      if (data.action === 'adminListBrands') {
        return { result: { ok: true, brands: [{ _id: 'brand-1', name: '南方' }] } };
      }
      if (data.action === 'upsertVideo') {
        return upsertResponse;
      }
      throw new Error(`unexpected ${data.action}`);
    },
    uploadFile: async ({ cloudPath, fileContent }) => {
      for await (const chunk of fileContent) {
        assert.ok(chunk.length > 0);
      }
      return { fileID: `cloud://${cloudPath}` };
    },
  };
}

test('upsert 返回确定性 BAD_INPUT 时写 failed 并允许后续重试', async (t) => {
  const manifestPath = fixture(t);

  const result = await executeImport({
    manifestPath,
    credentials: credentials(),
    createApp: () => upsertResponseApp({ result: { ok: false, code: 'BAD_INPUT', message: '写入失败' } }),
  });

  assert.equal(result.succeeded, 0);
  assert.equal(result.failed, 1);
  const saved = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(saved.entries[0].import.status, 'failed');
  assert.equal(saved.entries[0].import.draft.status, 'failed');
  assert.equal(saved.entries[0].import.draft.error, '写入失败');
  assert.equal(dryRun(manifestPath).ready.length, 1);
});

test('业务拒绝码全部写 failed，可修正后重试', async (t) => {
  for (const code of [
    'BAD_INPUT',
    'UNAUTHORIZED',
    'BAD_PIN',
    'NOT_FOUND',
    'UNKNOWN_ACTION',
    'CONTENT_REJECTED',
  ]) {
    const manifestPath = fixture(t);
    await executeImport({
      manifestPath,
      credentials: credentials(),
      createApp: () => upsertResponseApp({ result: { ok: false, code, message: `拒绝 ${code}` } }),
    });
    const saved = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(saved.entries[0].import.draft.status, 'failed', code);
  }
});

test('catch-all FAIL 结果不确定，保持 inflight 并阻断自动重试', async (t) => {
  const manifestPath = fixture(t);

  const result = await executeImport({
    manifestPath,
    credentials: credentials(),
    createApp: () => upsertResponseApp({ result: { ok: false, code: 'FAIL', message: '写入失败' } }),
  });

  assert.equal(result.failed, 1);
  const saved = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(saved.entries[0].import.draft.status, 'inflight');
  const plan = dryRun(manifestPath);
  assert.equal(plan.ready.length, 0);
  assert.deepEqual(plan.rejected[0].issues, ['DRAFT_INFLIGHT_REQUIRES_REVIEW']);
});

test('数据库等未知错误码结果不确定，保持 inflight', async (t) => {
  for (const code of ['DATABASE_REQUEST_FAILED', 'BRAND_NOT_EMPTY', 'TIMEOUT']) {
    const manifestPath = fixture(t);
    await executeImport({
      manifestPath,
      credentials: credentials(),
      createApp: () => upsertResponseApp({ result: { ok: false, code, message: '失败' } }),
    });
    const saved = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(saved.entries[0].import.draft.status, 'inflight', code);
  }
});

test('缺少响应信封或 ok 非布尔时结果不确定，保持 inflight', async (t) => {
  for (const upsertResponse of [
    undefined,
    null,
    {},
    { result: null },
    { result: {} },
    { result: { ok: 'false', code: 'BAD_INPUT' } },
    { result: { ok: 0, code: 'BAD_INPUT' } },
    { result: { ok: false } },
  ]) {
    const manifestPath = fixture(t);
    await executeImport({
      manifestPath,
      credentials: credentials(),
      createApp: () => upsertResponseApp(upsertResponse),
    });
    const saved = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(
      saved.entries[0].import.draft.status,
      'inflight',
      JSON.stringify(upsertResponse ?? null),
    );
  }
});

test('upsert 返回非字符串 id 时不写成功 checkpoint', async (t) => {
  for (const id of [123, true, { _id: 'video-1' }, ['video-1'], '   ']) {
    const manifestPath = fixture(t);
    const result = await executeImport({
      manifestPath,
      credentials: credentials(),
      createApp: () => upsertResponseApp({ result: { ok: true, id } }),
    });
    assert.equal(result.succeeded, 0, JSON.stringify(id));
    const saved = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(saved.entries[0].import.draft.status, 'inflight');
    assert.equal(saved.entries[0].import.draft.videoId, undefined);
  }
});

test('草稿 payload 的 tags 去空白并去重，与云端存储结果一致', async (t) => {
  const manifestPath = fixture(t, [
    manifestEntry({ tags: [' 点测量 ', '点测量', '放样', ' 放样'] }),
  ]);
  let upsert;
  const app = upsertResponseApp({ result: { ok: true, id: 'video-1' } });
  const inner = app.callFunction;
  app.callFunction = async (request) => {
    if (request.data.action === 'upsertVideo') {
      upsert = request.data;
    }
    return inner(request);
  };

  await executeImport({
    manifestPath,
    credentials: credentials(),
    createApp: () => app,
  });

  assert.deepEqual(upsert.tags, ['点测量', '放样']);
  assert.deepEqual(dryRun(manifestPath).skipped.length, 1);
});

test('执行模式缺少任一凭据时在远端调用前停止', async (t) => {
  const manifestPath = fixture(t);
  let created = false;

  await assert.rejects(
    executeImport({
      manifestPath,
      credentials: { ...credentials(), secretKey: '' },
      createApp: () => {
        created = true;
        return {};
      },
    }),
    /缺少运行时环境变量：TCB_SECRET_KEY/,
  );
  assert.equal(created, false);
});

test('execute 收集 rejected 并继续导入合法条目', async (t) => {
  const manifestPath = fixture(t, [
    manifestEntry({ sourceKey: 'rejected', brandName: '' }),
    manifestEntry(),
  ]);
  const calls = [];
  const app = {
    callFunction: async ({ data }) => {
      calls.push(data.action);
      if (data.action === 'adminLogin') {
        return { result: { ok: true, ticket: 'ticket-1' } };
      }
      if (data.action === 'adminListBrands') {
        return { result: { ok: true, brands: [{ _id: 'brand-1', name: '南方' }] } };
      }
      if (data.action === 'upsertVideo') {
        return { result: { ok: true, id: 'video-1' } };
      }
      throw new Error(`unexpected ${data.action}`);
    },
    uploadFile: async ({ cloudPath, fileContent }) => {
      for await (const chunk of fileContent) {
        assert.ok(chunk.length > 0);
      }
      return { fileID: `cloud://${cloudPath}` };
    },
  };

  const result = await executeImport({
    manifestPath,
    credentials: credentials(),
    createApp: () => app,
  });

  assert.deepEqual(calls, ['adminLogin', 'adminListBrands', 'upsertVideo']);
  assert.deepEqual(result, { succeeded: 1, failed: 0, rejected: 1, skipped: 0 });
});

test('已有 draft videoId 的失败重试更新原草稿', async (t) => {
  const manifestPath = fixture(t, [
    manifestEntry({
      import: {
        status: 'failed',
        cover: { status: 'success', fileId: 'cloud://cover/abc.jpg' },
        video: { status: 'success', fileId: 'cloud://video/abc.mp4' },
        draft: { status: 'failed', videoId: 'video-existing', error: 'timeout' },
      },
    }),
  ]);
  let upsert;
  const app = {
    callFunction: async ({ data }) => {
      if (data.action === 'adminLogin') {
        return { result: { ok: true, ticket: 'ticket-1' } };
      }
      if (data.action === 'adminListBrands') {
        return { result: { ok: true, brands: [{ _id: 'brand-1', name: '南方' }] } };
      }
      if (data.action === 'upsertVideo') {
        upsert = data;
        return { result: { ok: true, id: 'video-existing' } };
      }
      throw new Error(`unexpected ${data.action}`);
    },
    uploadFile: async () => {
      throw new Error('不应重复上传');
    },
  };

  await executeImport({
    manifestPath,
    credentials: credentials(),
    createApp: () => app,
  });

  assert.equal(upsert.id, 'video-existing');
});

test('更新原草稿再次失败时保留 draft videoId', async (t) => {
  const manifestPath = fixture(t, [
    manifestEntry({
      import: {
        status: 'failed',
        cover: { status: 'success', fileId: 'cloud://cover/abc.jpg' },
        video: { status: 'success', fileId: 'cloud://video/abc.mp4' },
        draft: { status: 'failed', videoId: 'video-existing', error: 'timeout' },
      },
    }),
  ]);
  const app = {
    callFunction: async ({ data }) => {
      if (data.action === 'adminLogin') {
        return { result: { ok: true, ticket: 'ticket-1' } };
      }
      if (data.action === 'adminListBrands') {
        return { result: { ok: true, brands: [{ _id: 'brand-1', name: '南方' }] } };
      }
      return { result: { ok: false, message: '仍然失败' } };
    },
    uploadFile: async () => {
      throw new Error('不应重复上传');
    },
  };

  await executeImport({
    manifestPath,
    credentials: credentials(),
    createApp: () => app,
  });

  const saved = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(saved.entries[0].import.draft.videoId, 'video-existing');
});

test('dry-run 明确警告占位符和 manifest 幂等凭据', (t) => {
  const manifestPath = fixture(t);
  const plan = dryRun(manifestPath);

  assert.deepEqual(plan.warnings, [
    'brandId、coverFileId、videoFileId 为 dry-run 占位符，不是可写入值',
    'manifest 是 execute 的幂等凭据；请先备份，丢失后不可从零重跑 execute',
  ]);
});

test('汇总含 rejected 时要求非零退出', () => {
  assert.equal(hasFailures({ failed: 0, rejected: 1 }), true);
  assert.equal(hasFailures({ failed: 0, rejected: 0 }), false);
});

test('调用 upsertVideo 前先落盘 inflight checkpoint', async (t) => {
  const manifestPath = fixture(t);
  let observedDraftStatus;
  const app = {
    callFunction: async ({ data }) => {
      if (data.action === 'adminLogin') {
        return { result: { ok: true, ticket: 'ticket-1' } };
      }
      if (data.action === 'adminListBrands') {
        return { result: { ok: true, brands: [{ _id: 'brand-1', name: '南方' }] } };
      }
      const snapshot = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      observedDraftStatus = snapshot.entries[0].import.draft?.status;
      return { result: { ok: true, id: 'video-1' } };
    },
    uploadFile: async ({ cloudPath, fileContent }) => {
      for await (const chunk of fileContent) {
        assert.ok(chunk.length > 0);
      }
      return { fileID: `cloud://${cloudPath}` };
    },
  };

  await executeImport({
    manifestPath,
    credentials: credentials(),
    createApp: () => app,
  });
  assert.equal(observedDraftStatus, 'inflight');
});

test('upsert 超时错误不向 manifest 泄漏 adminLogin ticket', async (t) => {
  const manifestPath = fixture(t);
  const app = {
    callFunction: async ({ data }) => {
      if (data.action === 'adminLogin') {
        return { result: { ok: true, ticket: 'ticket-runtime-secret' } };
      }
      if (data.action === 'adminListBrands') {
        return { result: { ok: true, brands: [{ _id: 'brand-1', name: '南方' }] } };
      }
      throw new Error('请求 ticket-runtime-secret 超时');
    },
    uploadFile: async ({ cloudPath, fileContent }) => {
      for await (const chunk of fileContent) {
        assert.ok(chunk.length > 0);
      }
      return { fileID: `cloud://${cloudPath}` };
    },
  };

  const result = await executeImport({
    manifestPath,
    credentials: credentials(),
    createApp: () => app,
  });

  assert.equal(result.succeeded, 0);
  const savedText = fs.readFileSync(manifestPath, 'utf8');
  assert.equal(savedText.includes('ticket-runtime-secret'), false);
  const saved = JSON.parse(savedText);
  assert.equal(saved.entries[0].import.draft.status, 'inflight');
  assert.equal(saved.entries[0].import.draft.error, '请求 [REDACTED] 超时');
});

test('upsert 成功响应缺少 id 时不写成功 checkpoint', async (t) => {
  const manifestPath = fixture(t);
  const app = {
    callFunction: async ({ data }) => {
      if (data.action === 'adminLogin') {
        return { result: { ok: true, ticket: 'ticket-1' } };
      }
      if (data.action === 'adminListBrands') {
        return { result: { ok: true, brands: [{ _id: 'brand-1', name: '南方' }] } };
      }
      return { result: { ok: true, id: '' } };
    },
    uploadFile: async ({ cloudPath, fileContent }) => {
      for await (const chunk of fileContent) {
        assert.ok(chunk.length > 0);
      }
      return { fileID: `cloud://${cloudPath}` };
    },
  };

  const result = await executeImport({
    manifestPath,
    credentials: credentials(),
    createApp: () => app,
  });

  assert.equal(result.succeeded, 0);
  assert.equal(result.failed, 1);
  const saved = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(saved.entries[0].import.status, 'failed');
  assert.equal(saved.entries[0].import.draft.status, 'inflight');
  assert.equal(saved.entries[0].import.draft.videoId, undefined);
  assert.equal(dryRun(manifestPath).skipped.length, 0);
});

test('adminLogin stderr 脱敏四项环境凭据', async (t) => {
  const manifestPath = fixture(t);
  let stderr = '';
  const env = {
    TCB_ENV_ID: 'env-runtime-secret',
    TCB_SECRET_ID: 'id-runtime-secret',
    TCB_SECRET_KEY: 'key-runtime-secret',
    ADMIN_PIN: 'pin-runtime-secret',
  };

  const exitCode = await runCli({
    argv: ['--manifest', manifestPath, '--execute'],
    env,
    createApp: () => ({
      callFunction: async () => {
        throw new Error(
          '登录失败 env-runtime-secret id-runtime-secret key-runtime-secret pin-runtime-secret',
        );
      },
    }),
    stdout: { write() {} },
    stderr: { write(value) { stderr += value; } },
  });

  assert.equal(exitCode, 1);
  for (const secret of Object.values(env)) {
    assert.equal(stderr.includes(secret), false);
  }
  assert.match(stderr, /登录失败 \[REDACTED\]/);
});

test('品牌阶段 stderr 同时脱敏 ADMIN_PIN 与运行时 ticket', async (t) => {
  const manifestPath = fixture(t);
  let stderr = '';

  const exitCode = await runCli({
    argv: ['--manifest', manifestPath, '--execute'],
    env: {
      TCB_ENV_ID: 'env-id',
      TCB_SECRET_ID: 'secret-id',
      TCB_SECRET_KEY: 'secret-key',
      ADMIN_PIN: 'admin-pin',
    },
    createApp: () => ({
      callFunction: async ({ data }) => {
        if (data.action === 'adminLogin') {
          return { result: { ok: true, ticket: 'ticket-runtime-secret' } };
        }
        throw new Error('品牌失败 admin-pin ticket-runtime-secret');
      },
    }),
    stdout: { write() {} },
    stderr: { write(value) { stderr += value; } },
  });

  assert.equal(exitCode, 1);
  assert.equal(stderr.includes('admin-pin'), false);
  assert.equal(stderr.includes('ticket-runtime-secret'), false);
  assert.equal(stderr, '品牌失败 [REDACTED] [REDACTED]\n');
});

test('inflight manifest 写失败的顶层 stderr 脱敏凭据与 ticket', async (t) => {
  const manifestPath = fixture(t);
  let stderr = '';

  const exitCode = await runCli({
    argv: ['--manifest', manifestPath, '--execute'],
    env: {
      TCB_ENV_ID: 'env-id',
      TCB_SECRET_ID: 'secret-id',
      TCB_SECRET_KEY: 'secret-key',
      ADMIN_PIN: 'admin-pin',
    },
    createApp: () => ({
      callFunction: async ({ data }) => {
        if (data.action === 'adminLogin') {
          return { result: { ok: true, ticket: 'ticket-runtime-secret' } };
        }
        if (data.action === 'adminListBrands') {
          return { result: { ok: true, brands: [{ _id: 'brand-1', name: '南方' }] } };
        }
        throw new Error('不应调用 upsertVideo');
      },
      uploadFile: async ({ cloudPath, fileContent }) => {
        for await (const chunk of fileContent) {
          assert.ok(chunk.length > 0);
        }
        return { fileID: `cloud://${cloudPath}` };
      },
    }),
    persistManifest: (targetPath, manifest) => {
      if (manifest.entries[0].import?.draft?.status === 'inflight') {
        throw new Error('落盘失败 admin-pin ticket-runtime-secret');
      }
      fs.writeFileSync(targetPath, JSON.stringify(manifest));
    },
    stdout: { write() {} },
    stderr: { write(value) { stderr += value; } },
  });

  assert.equal(exitCode, 1);
  assert.equal(stderr, '落盘失败 [REDACTED] [REDACTED]\n');
});
