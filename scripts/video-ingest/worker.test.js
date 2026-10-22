'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { describe, it } = require('node:test');

const {
  createJobDependencies,
  createVideoCover,
  deleteCloudFiles,
  downloadVideoFile,
  probeLocalMedia,
  runCli,
  runInTemporaryWorkspace,
  transcodeLocalMedia,
} = require('./worker');

const COMPLETE_CREDENTIALS = {
  TCB_ENV_ID: 'env-id',
  TCB_SECRET_ID: 'secret-id',
  TCB_SECRET_KEY: 'secret-key',
  ADMIN_PIN: 'admin-pin',
};

function writePlaybackMp4(filePath) {
  const box = (type) => {
    const buffer = Buffer.alloc(8);
    buffer.writeUInt32BE(8, 0);
    buffer.write(type, 4, 'ascii');
    return buffer;
  };
  fs.writeFileSync(filePath, Buffer.concat([box('moov'), box('mdat')]));
}

describe('worker 生产胶水', () => {
  it('生产任务依赖包含基于最终播放文件的自动封面生成器', () => {
    const deps = createJobDependencies({
      app: {},
      catalog: {},
      workerId: 'worker',
      workspace: '/tmp/workspace',
      env: {},
    });

    assert.equal(typeof deps.createCover, 'function');
  });

  it('云文件逐项删除失败时抛出不含 fileID 的固定错误', async () => {
    const privateFileId = 'cloud://private-old-video';
    await assert.rejects(
      () =>
        deleteCloudFiles(
          {
            deleteFile: async ({ fileList }) => {
              assert.deepEqual(fileList, [privateFileId]);
              return {
                fileList: [
                  {
                    fileID: privateFileId,
                    code: 'STORAGE_FILE_NOT_EXIST',
                  },
                ],
              };
            },
          },
          [privateFileId],
        ),
      (error) =>
        error.message === '云文件删除失败' &&
        !error.message.includes(privateFileId),
    );
  });

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

  it('H.264 + AAC 但关键帧间隔 10 秒时仍需要转码', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-probe-test-'));
    try {
      const mediaPath = path.join(root, 'input.mp4');
      writePlaybackMp4(mediaPath);
      const calls = [];
      const probe = probeLocalMedia(mediaPath, (command, args, options) => {
        calls.push({ command, args, options });
        return calls.length === 1
          ? {
              status: 0,
              stdout: Buffer.from(JSON.stringify({
                format: { duration: '12.5' },
                streams: [
                  {
                    codec_type: 'video',
                    codec_name: 'h264',
                    profile: 'Main',
                    pix_fmt: 'yuv420p',
                    width: 1280,
                    height: 720,
                    avg_frame_rate: '30/1',
                    has_b_frames: 0,
                  },
                  { codec_type: 'audio', codec_name: 'aac' },
                ],
              })),
              stderr: Buffer.alloc(0),
            }
          : {
              status: 0,
              stdout: Buffer.from('0.000000,K_\n10.000000,K_\n'),
              stderr: Buffer.alloc(0),
            };
      });

      assert.equal(calls.length, 2);
      assert.equal(calls[0].command, 'ffprobe');
      assert.equal(calls[0].args.at(-1), mediaPath);
      assert.equal(calls[0].options.timeout > 0, true);
      assert.equal(calls[0].options.killSignal, 'SIGKILL');
      assert.equal(probe.needsTranscode, true);
      assert.equal(probe.playback.compliant, false);
      assert.equal(probe.playback.maxKeyframeGapSec, 10);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('时长四舍五入到一位小数，避免字幕越过云端归一化后的上界', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-probe-duration-'));
    try {
      const mediaPath = path.join(root, 'input.mp4');
      writePlaybackMp4(mediaPath);
      let callCount = 0;
      const probe = probeLocalMedia(mediaPath, () => {
        callCount += 1;
        return callCount === 1
          ? {
              status: 0,
              stdout: Buffer.from(JSON.stringify({
                format: { duration: '12.345678' },
                streams: [{
                  codec_type: 'video',
                  codec_name: 'h264',
                  profile: 'Main',
                  pix_fmt: 'yuv420p',
                  width: 1280,
                  height: 720,
                  avg_frame_rate: '30/1',
                  has_b_frames: 0,
                }],
              })),
              stderr: Buffer.alloc(0),
            }
          : {
              status: 0,
              stdout: Buffer.from('0.000000,K_\n2.000000,K_\n'),
              stderr: Buffer.alloc(0),
            };
      });

      assert.equal(probe.durationSec, 12.3);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('时长舍入后为零时按媒体信息不完整拒绝', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-probe-zero-'));
    try {
      const mediaPath = path.join(root, 'input.mp4');
      writePlaybackMp4(mediaPath);
      let callCount = 0;
      assert.throws(
        () =>
          probeLocalMedia(mediaPath, () => {
            callCount += 1;
            return callCount === 1
              ? {
                  status: 0,
                  stdout: Buffer.from(JSON.stringify({
                    format: { duration: '0.04' },
                    streams: [{
                      codec_type: 'video',
                      codec_name: 'h264',
                      profile: 'Main',
                      pix_fmt: 'yuv420p',
                      width: 1280,
                      height: 720,
                      avg_frame_rate: '30/1',
                      has_b_frames: 0,
                    }],
                  })),
                  stderr: Buffer.alloc(0),
                }
              : {
                  status: 0,
                  stdout: Buffer.from('0.000000,K_\n'),
                  stderr: Buffer.alloc(0),
                };
          }),
        /媒体信息不完整/,
      );
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

  it('临时 URL 提前返回后仍等待二进制流完整落盘', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-download-test-'));
    try {
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = { 'content-length': '14' };
      const request = new EventEmitter();
      request.setTimeout = () => request;
      response.setTimeout = () => response;
      let resolved = false;
      const downloading = downloadVideoFile({
        app: {
          getTempFileURL: async ({ fileList }) => {
            assert.deepEqual(fileList, ['cloud://video']);
            return {
              fileList: [{
                code: 'SUCCESS',
                fileID: 'cloud://video',
                tempFileURL: 'https://storage.invalid/private-token',
              }],
            };
          },
        },
        fileId: 'cloud://video',
        workspace: root,
        requestUrl: (url, onResponse) => {
          assert.equal(url, 'https://storage.invalid/private-token');
          onResponse(response);
          setTimeout(() => {
            response.end(Buffer.from('complete-video'));
          }, 20);
          return request;
        },
      });
      downloading.then(() => {
        resolved = true;
      });

      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
      assert.equal(resolved, false);

      const localPath = await downloading;
      assert.deepEqual(fs.readFileSync(localPath), Buffer.from('complete-video'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('空下载流不会作为成功文件返回', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-download-empty-'));
    try {
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = { 'content-length': '0' };
      const request = new EventEmitter();
      request.setTimeout = () => request;
      response.setTimeout = () => response;
      await assert.rejects(
        () =>
          downloadVideoFile({
            app: {
              getTempFileURL: async () => ({
                fileList: [{
                  code: 'SUCCESS',
                  fileID: 'cloud://video',
                  tempFileURL: 'https://storage.invalid/empty',
                }],
              }),
            },
            fileId: 'cloud://video',
            workspace: root,
            requestUrl: (url, onResponse) => {
              onResponse(response);
              response.end();
              return request;
            },
          }),
        /下载文件为空/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('HTTP 已建立但不发 body 时超时销毁请求和响应', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-download-timeout-'));
    const response = new PassThrough();
    response.statusCode = 200;
    response.headers = {};
    const request = new EventEmitter();
    let requestTimeout = 0;
    let responseTimeout = 0;
    let requestDestroyed = false;
    let responseDestroyed = false;
    let guardTimer;
    request.setTimeout = (milliseconds) => {
      requestTimeout = milliseconds;
      return request;
    };
    request.destroy = (error) => {
      requestDestroyed = true;
      request.emit('error', error);
    };
    response.setTimeout = (milliseconds) => {
      responseTimeout = milliseconds;
      return response;
    };
    const destroyResponse = response.destroy.bind(response);
    response.destroy = (error) => {
      responseDestroyed = true;
      return destroyResponse(error);
    };

    try {
      const downloading = downloadVideoFile({
        app: {
          getTempFileURL: async () => ({
            fileList: [{
              code: 'SUCCESS',
              fileID: 'cloud://video',
              tempFileURL: 'https://storage.invalid/stalled',
            }],
          }),
        },
        fileId: 'cloud://video',
        workspace: root,
        downloadTimeoutMs: 20,
        requestUrl: (url, onResponse) => {
          onResponse(response);
          return request;
        },
      });
      const guard = new Promise((resolve, reject) => {
        guardTimer = setTimeout(
          () => reject(new Error('下载超时测试守卫触发')),
          200,
        );
      });

      await assert.rejects(
        Promise.race([downloading, guard]),
        /下载文件失败/,
      );
      assert.equal(requestTimeout, 20);
      assert.equal(responseTimeout, 20);
      assert.equal(requestDestroyed, true);
      assert.equal(responseDestroyed, true);
    } finally {
      clearTimeout(guardTimer);
      request.removeAllListeners();
      response.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('下载超时后 pipeline 延迟拒绝不会成为未处理拒绝', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-download-reject-'));
    const response = new PassThrough();
    response.statusCode = 200;
    response.headers = {};
    const request = new EventEmitter();
    const unhandledRejections = [];
    const onUnhandledRejection = (error) => {
      unhandledRejections.push(error);
    };
    request.setTimeout = () => request;
    request.destroy = (error) => {
      request.emit('error', error);
    };
    response.setTimeout = () => response;
    const destroyResponse = response.destroy.bind(response);
    response.destroy = (error) => {
      setTimeout(() => {
        destroyResponse(error);
      }, 20);
      return response;
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      await assert.rejects(
        () =>
          downloadVideoFile({
            app: {
              getTempFileURL: async () => ({
                fileList: [{
                  code: 'SUCCESS',
                  fileID: 'cloud://video',
                  tempFileURL: 'https://storage.invalid/delayed-rejection',
                }],
              }),
            },
            fileId: 'cloud://video',
            workspace: root,
            downloadTimeoutMs: 10,
            requestUrl: (url, onResponse) => {
              onResponse(response);
              return request;
            },
          }),
        /下载文件失败/,
      );
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      assert.equal(unhandledRejections.length, 0);
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection);
      request.removeAllListeners();
      response.destroy = destroyResponse;
      response.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ffmpeg 使用统一播放规格参数并设置超时', async () => {
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
        probe: { hasAudio: true },
        runCommand: (command, args, options) => {
          assert.equal(command, 'ffmpeg');
          assert.equal(args.includes(mediaPath), true);
          assert.equal(args[args.indexOf('-profile:v') + 1], 'main');
          assert.equal(args[args.indexOf('-bf') + 1], '0');
          assert.equal(
            args[args.indexOf('-force_key_frames') + 1],
            'expr:gte(t,n_forced*2)',
          );
          assert.equal(args[args.indexOf('-movflags') + 1], '+faststart');
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

  it('自动封面按 16:9 抽帧，首帧失败时改试第 3 秒并上传', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-cover-test-'));
    const seeks = [];
    try {
      const mediaPath = path.join(root, 'input.mp4');
      fs.writeFileSync(mediaPath, 'video');
      const fileId = await createVideoCover({
        app: {
          uploadFile: async ({ cloudPath, fileContent }) => {
            assert.match(cloudPath, /^cover\/auto\/.+\.jpg$/);
            const completed = once(fileContent, 'end');
            fileContent.resume();
            await completed;
            return { fileID: 'cloud://auto-cover' };
          },
        },
        mediaPath,
        workspace: root,
        durationSec: 10,
        runCommand: (command, args, options) => {
          assert.equal(command, 'ffmpeg');
          seeks.push(Number(args[args.indexOf('-ss') + 1]));
          assert.equal(
            args[args.indexOf('-vf') + 1],
            'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720',
          );
          assert.equal(options.timeout > 0, true);
          if (seeks.length === 1) {
            return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
          }
          fs.writeFileSync(path.join(root, 'auto-cover.jpg'), 'cover');
          return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        },
      });

      assert.equal(fileId, 'cloud://auto-cover');
      assert.deepEqual(seeks, [1, 3]);
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
