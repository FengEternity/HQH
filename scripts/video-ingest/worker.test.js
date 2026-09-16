'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const {
  downloadVideoFile,
  probeLocalMedia,
  runCli,
  runInTemporaryWorkspace,
  transcodeLocalMedia,
  transcribeLocalFile,
} = require('./worker');

const COMPLETE_CREDENTIALS = {
  TCB_ENV_ID: 'env-id',
  TCB_SECRET_ID: 'secret-id',
  TCB_SECRET_KEY: 'secret-key',
  ADMIN_PIN: 'admin-pin',
};

describe('worker 生产胶水', () => {
  it('凭据缺失时非零退出且不打印任何凭据值', async () => {
    let stderr = '';
    let createCount = 0;
    const exitCode = await runCli({
      env: {
        TCB_ENV_ID: 'env-secret-value',
        TCB_SECRET_ID: '',
        TCB_SECRET_KEY: 'key-secret-value',
        ADMIN_PIN: 'pin-secret-value',
      },
      stderr: { write: (text) => { stderr += text; } },
      createApp: () => {
        createCount += 1;
        return {};
      },
      maxIterations: 0,
    });

    assert.equal(exitCode, 1);
    assert.equal(stderr, '缺少云开发凭据\n');
    assert.equal(createCount, 0);
    assert.equal(stderr.includes('secret-value'), false);
  });

  it('ffprobe 识别非 H.264+AAC 媒体需要转码', () => {
    const calls = [];
    const probe = probeLocalMedia('/private/input.mp4', (command, args, options) => {
      calls.push({ command, args, options });
      return {
        status: 0,
        stdout: Buffer.from(JSON.stringify({
          format: { duration: '12.5' },
          streams: [
            { codec_type: 'video', codec_name: 'hevc' },
            { codec_type: 'audio', codec_name: 'opus' },
          ],
        })),
        stderr: Buffer.alloc(0),
      };
    });

    assert.equal(calls[0].command, 'ffprobe');
    assert.equal(calls[0].args.at(-1), '/private/input.mp4');
    assert.equal(calls[0].options.timeout > 0, true);
    assert.equal(calls[0].options.killSignal, 'SIGKILL');
    assert.deepEqual(probe, {
      hasAudio: true,
      videoCodec: 'hevc',
      audioCodec: 'opus',
      durationSec: 12.5,
      needsTranscode: true,
    });
  });

  it('单文件转写通过临时 manifest 调用既有 CLI 并读取结果', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-worker-test-'));
    try {
      const mediaPath = path.join(root, 'input.mp4');
      fs.writeFileSync(mediaPath, 'local-only');
      const result = transcribeLocalFile({
        mediaPath,
        durationSec: 4,
        pythonCommand: '/venv/python',
        modelName: 'medium',
        runCommand: (command, args, options) => {
          assert.equal(command, '/venv/python');
          assert.equal(args[0].endsWith('transcribe.py'), true);
          assert.equal(options.timeout > 0, true);
          assert.equal(options.killSignal, 'SIGKILL');
          const manifestPath = args[args.indexOf('--manifest') + 1];
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          assert.equal(manifest.entries[0].prepared.media, 'input.mp4');
          manifest.entries[0].transcription = { status: 'ready' };
          manifest.entries[0].transcriptSegments = [
            { startSec: 0, endSec: 1, text: '本地字幕' },
          ];
          fs.writeFileSync(manifestPath, JSON.stringify(manifest));
          return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        },
      });

      assert.deepEqual(result, {
        ok: true,
        skipped: false,
        segments: [{ startSec: 0, endSec: 1, text: '本地字幕' }],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('临时工作目录在异常后仍安全清理', async () => {
    let temporaryDirectory = '';

    await assert.rejects(
      () => runInTemporaryWorkspace(async (directory) => {
        temporaryDirectory = directory;
        fs.writeFileSync(path.join(directory, 'private.mp4'), 'x');
        throw new Error('boom');
      }),
      /boom/,
    );

    assert.notEqual(temporaryDirectory, '');
    assert.equal(fs.existsSync(temporaryDirectory), false);
  });

  it('下载不依赖 tempFilePath 提前 resolve 并完整写入 Buffer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-download-test-'));
    let delayedWrite;
    const app = {
      downloadFile: async (options) => {
        if (options.tempFilePath) {
          fs.writeFileSync(options.tempFilePath, '');
          delayedWrite = new Promise((resolve) => {
            setTimeout(() => {
              fs.writeFileSync(options.tempFilePath, 'late-video');
              resolve();
            }, 20);
          });
          return {};
        }
        return { fileContent: Buffer.from('complete-video') };
      },
    };
    try {
      const earlyPath = path.join(root, 'sdk-early.mp4');
      await app.downloadFile({
        fileID: 'cloud://video',
        tempFilePath: earlyPath,
      });
      assert.equal(fs.statSync(earlyPath).size, 0);

      const localPath = await downloadVideoFile({
        app,
        fileId: 'cloud://video',
        workspace: root,
      });

      assert.equal(fs.readFileSync(localPath, 'utf8'), 'complete-video');
      await delayedWrite;
      assert.equal(fs.readFileSync(earlyPath, 'utf8'), 'late-video');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ffmpeg 设置超时和强制终止信号', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-transcode-test-'));
    try {
      const mediaPath = path.join(root, 'input.mp4');
      fs.writeFileSync(mediaPath, 'video');
      await transcodeLocalMedia({
        app: {
          uploadFile: async ({ fileContent }) => {
            const completed = once(fileContent, 'end');
            fileContent.resume();
            await completed;
            return { fileID: 'cloud://transcoded' };
          },
        },
        mediaPath,
        workspace: root,
        runCommand: (command, args, options) => {
          assert.equal(command, 'ffmpeg');
          assert.equal(args.includes(mediaPath), true);
          assert.equal(options.timeout > 0, true);
          assert.equal(options.killSignal, 'SIGKILL');
          fs.writeFileSync(path.join(root, 'transcoded.mp4'), 'converted');
          return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('处理失败后也等待退避再进入下一轮', async () => {
    const waits = [];
    const exitCode = await runCli({
      env: COMPLETE_CREDENTIALS,
      createApp: () => ({
        callFunction: async ({ data }) => {
          if (data.action === 'adminLogin') {
            return { result: { ok: true, ticket: 'ticket-1' } };
          }
          return { result: { ok: false, code: 'FAIL' } };
        },
      }),
      maxIterations: 1,
      wait: async (milliseconds) => waits.push(milliseconds),
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(waits, [5000]);
  });

  it('票据失效时重新 adminLogin 一次并继续轮询', async () => {
    const actions = [];
    let loginCount = 0;
    const waits = [];
    const exitCode = await runCli({
      env: COMPLETE_CREDENTIALS,
      createApp: () => ({
        callFunction: async ({ data }) => {
          actions.push(`${data.action}:${data.ticket || ''}`);
          if (data.action === 'adminLogin') {
            loginCount += 1;
            return { result: { ok: true, ticket: `ticket-${loginCount}` } };
          }
          if (data.action === 'claimVideoIngest' && data.ticket === 'ticket-1') {
            return { result: { ok: false, code: 'UNAUTHORIZED' } };
          }
          return { result: { ok: true, job: null } };
        },
      }),
      maxIterations: 1,
      wait: async (milliseconds) => waits.push(milliseconds),
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(actions, [
      'adminLogin:',
      'claimVideoIngest:ticket-1',
      'adminLogin:',
      'claimVideoIngest:ticket-2',
    ]);
    assert.deepEqual(waits, [5000]);
  });
});
