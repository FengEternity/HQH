'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const {
  probeLocalMedia,
  runCli,
  runInTemporaryWorkspace,
  transcribeLocalFile,
} = require('./worker');

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
    const probe = probeLocalMedia('/private/input.mp4', (command, args) => {
      calls.push({ command, args });
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
        runCommand: (command, args) => {
          assert.equal(command, '/venv/python');
          assert.equal(args[0].endsWith('transcribe.py'), true);
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
});
