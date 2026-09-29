const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runCli } = require('./replace-playback');

const CREDENTIALS = {
  TCB_ENV_ID: 'env-id',
  TCB_SECRET_ID: 'secret-id',
  TCB_SECRET_KEY: 'secret-key',
  ADMIN_PIN: '123456',
};

function playback(overrides = {}) {
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

function fixture(t, entries) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-replace-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mediaDirectory = path.join(directory, 'media');
  fs.mkdirSync(mediaDirectory);
  for (const entry of entries) {
    fs.writeFileSync(path.join(directory, entry.prepared.media), 'mp4');
  }
  const manifestPath = path.join(directory, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, entries }));
  return { directory, manifestPath };
}

function entry(title, overrides = {}) {
  return {
    title,
    durationSec: 12.3,
    media: {
      videoCodec: 'h264',
      audioCodec: 'aac',
      hasAudio: true,
      playback: playback(),
    },
    prepared: { media: `media/${title}.mp4` },
    ...overrides,
  };
}

function appDouble({ videos = [], failAction = false, failOldDelete = false } = {}) {
  const calls = [];
  return {
    calls,
    app: {
      uploadFile: async ({ cloudPath, fileContent }) => {
        if (fileContent) {
          await new Promise((resolve, reject) => {
            fileContent.on('error', reject);
            fileContent.on('end', resolve);
            fileContent.resume();
          });
        }
        calls.push(['uploadFile', cloudPath]);
        return { fileID: `cloud://new-${calls.length}` };
      },
      deleteFile: async ({ fileList }) => {
        calls.push(['deleteFile', fileList[0]]);
        if (failOldDelete && String(fileList[0]).startsWith('cloud://old')) {
          return { fileList: [{ fileID: fileList[0], code: 'FAILED' }] };
        }
        return { fileList: [{ fileID: fileList[0], code: 'SUCCESS' }] };
      },
      callFunction: async ({ data }) => {
        calls.push([data.action, data.brandId || data.id || '']);
        if (data.action === 'adminLogin') {
          return { result: { ok: true, ticket: 'ticket-secret' } };
        }
        if (data.action === 'adminListBrands') {
          return { result: { ok: true, brands: [{ _id: 'brand-1', name: '南方' }] } };
        }
        if (data.action === 'adminListVideos') {
          return { result: { ok: true, videos } };
        }
        if (data.action === 'replacePlaybackMedia') {
          if (failAction) {
            return { result: { ok: false, code: 'BAD_INPUT', message: 'ticket-secret secret-key' } };
          }
          return {
            result: {
              ok: true,
              id: data.id,
              oldVideoFileId: data.expectedVideoFileId,
            },
          };
        }
        return { result: { ok: false, code: 'UNKNOWN_ACTION' } };
      },
    },
  };
}

test('缺少凭据时停止且不创建 SDK', async () => {
  let created = 0;
  const stderr = [];
  const code = await runCli({
    argv: ['--manifest', 'manifest.json'],
    env: {},
    createApp: () => {
      created += 1;
      return {};
    },
    stderr: { write: (chunk) => stderr.push(chunk) },
  });

  assert.equal(code, 1);
  assert.equal(created, 0);
  assert.equal(stderr.join('').includes('TCB_'), true);
});

test('默认 dry-run 只读取远端清单，不上传不写库', async (t) => {
  const { manifestPath, directory } = fixture(t, [entry(' 南方点测量 ')]);
  const remote = appDouble({
    videos: [{ _id: 'v1', title: '南方点测量', videoFileId: 'cloud://old-1' }],
  });
  let created = 0;
  const stdout = [];

  const code = await runCli({
    argv: ['--manifest', manifestPath],
    env: CREDENTIALS,
    createApp: () => {
      created += 1;
      return remote.app;
    },
    stdout: { write: (chunk) => stdout.push(chunk) },
  });

  const output = stdout.join('');
  assert.equal(code, 0);
  assert.equal(created, 1);
  assert.equal(remote.calls.some((call) => call[0] === 'uploadFile'), false);
  assert.equal(remote.calls.some((call) => call[0] === 'replacePlaybackMedia'), false);
  assert.equal(remote.calls.some((call) => call[0] === 'deleteFile'), false);
  assert.match(output, /ready 1/);
  assert.match(output, /南方点测量/);
  assert.equal(output.includes(directory), false);
  assert.equal(output.includes('ticket-secret'), false);
  assert.equal(output.includes('secret-key'), false);
});

test('零条、多条和不合格成品列为拒绝', async (t) => {
  const entries = [
    entry('没有'),
    entry('重复'),
    entry('不合格', {
      media: {
        videoCodec: 'h264',
        audioCodec: 'aac',
        hasAudio: true,
        playback: playback({ compliant: false }),
      },
    }),
  ];
  const { manifestPath } = fixture(t, entries);
  const remote = appDouble({
    videos: [
      { _id: 'a', title: '重复', videoFileId: 'cloud://a' },
      { _id: 'b', title: '重复', videoFileId: 'cloud://b' },
    ],
  });
  const stdout = [];

  const code = await runCli({
    argv: ['--manifest', manifestPath, '--dry-run'],
    env: CREDENTIALS,
    createApp: () => remote.app,
    stdout: { write: (chunk) => stdout.push(chunk) },
  });

  const output = stdout.join('');
  assert.equal(code, 1);
  assert.match(output, /rejected 3/);
  assert.match(output, /没有/);
  assert.match(output, /重复/);
  assert.match(output, /不合格/);
  assert.equal(remote.calls.some((call) => call[0] === 'uploadFile'), false);
});

test('execute 先上传再替换，成功后删除旧文件', async (t) => {
  const { manifestPath } = fixture(t, [entry('南方点测量')]);
  const remote = appDouble({
    videos: [{ _id: 'v1', title: '南方点测量', videoFileId: 'cloud://old-1' }],
  });
  const stdout = [];

  const code = await runCli({
    argv: ['--manifest', manifestPath, '--execute'],
    env: CREDENTIALS,
    createApp: () => remote.app,
    randomUUID: () => 'uuid-1',
    stdout: { write: (chunk) => stdout.push(chunk) },
  });

  assert.equal(code, 0);
  assert.deepEqual(
    remote.calls.filter((call) => ['uploadFile', 'replacePlaybackMedia', 'deleteFile'].includes(call[0])),
    [
      ['uploadFile', 'video/processed/uuid-1.mp4'],
      ['replacePlaybackMedia', 'v1'],
      ['deleteFile', 'cloud://old-1'],
    ],
  );
  assert.match(stdout.join(''), /succeeded 1/);
});

test('替换失败时删除新文件并保留旧文件', async (t) => {
  const { manifestPath } = fixture(t, [entry('南方点测量'), entry('另一条')]);
  const remote = appDouble({
    failAction: true,
    videos: [
      { _id: 'v1', title: '南方点测量', videoFileId: 'cloud://old-1' },
      { _id: 'v2', title: '另一条', videoFileId: 'cloud://old-2' },
    ],
  });
  const stdout = [];

  const code = await runCli({
    argv: ['--manifest', manifestPath, '--execute'],
    env: CREDENTIALS,
    createApp: () => remote.app,
    randomUUID: () => 'uuid-1',
    stdout: { write: (chunk) => stdout.push(chunk) },
  });

  const output = stdout.join('');
  assert.equal(code, 1);
  assert.match(output, /failed 2/);
  assert.equal(output.includes('secret-key'), false);
  assert.equal(output.includes('ticket-secret'), false);
  const deletes = remote.calls.filter((call) => call[0] === 'deleteFile').map((call) => call[1]);
  assert.equal(deletes.some((fileId) => String(fileId).startsWith('cloud://old')), false);
  assert.equal(deletes.length, 2);
});

test('旧文件删除失败只记 warning，不回滚已成功替换', async (t) => {
  const { manifestPath } = fixture(t, [entry('南方点测量')]);
  const remote = appDouble({
    failOldDelete: true,
    videos: [{ _id: 'v1', title: '南方点测量', videoFileId: 'cloud://old-1' }],
  });
  const stdout = [];

  const code = await runCli({
    argv: ['--manifest', manifestPath, '--execute'],
    env: CREDENTIALS,
    createApp: () => remote.app,
    randomUUID: () => 'uuid-1',
    stdout: { write: (chunk) => stdout.push(chunk) },
  });

  const output = stdout.join('');
  assert.equal(code, 0);
  assert.match(output, /succeeded 1/);
  assert.match(output, /warning 1/);
  assert.match(output, /南方点测量/);
  const replaced = remote.calls.some((call) => call[0] === 'replacePlaybackMedia');
  assert.equal(replaced, true);
});
