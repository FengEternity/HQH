const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { dryRun, executeImport, hasFailures, parseArguments } = require('./import');

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
    media: { videoCodec: 'h264', audioCodec: 'aac', hasAudio: true },
    prepared: { media: 'media/abc.mp4', cover: 'covers/abc.jpg' },
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

test('upsert 失败保留 inflight 状态且不声称成功', async (t) => {
  const manifestPath = fixture(t);
  const app = {
    callFunction: async ({ data }) => {
      if (data.action === 'adminLogin') {
        return { result: { ok: true, ticket: 'ticket-1' } };
      }
      if (data.action === 'adminListBrands') {
        return { result: { ok: true, brands: [{ _id: 'brand-1', name: '南方' }] } };
      }
      if (data.action === 'upsertVideo') {
        return { result: { ok: false, code: 'FAIL', message: '写入失败' } };
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

  assert.equal(result.succeeded, 0);
  assert.equal(result.failed, 1);
  const saved = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(saved.entries[0].import.status, 'failed');
  assert.equal(saved.entries[0].import.draft.status, 'inflight');
  assert.equal(saved.entries[0].import.draft.error, '写入失败');
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
