#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');

const cloudbase = require('@cloudbase/node-sdk');

const { PLACEHOLDER_INTRO, resolveAutoIntro } = require('./lib/autoIntro');
const { runOnce } = require('./lib/workerLoop');

const IDLE_SLEEP_MS = 5000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const FFPROBE_TIMEOUT_MS = 30 * 1000;
const FFMPEG_TIMEOUT_MS = 30 * 60 * 1000;
const TRANSCRIBE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const TRANSCRIBE_SCRIPT = path.join(__dirname, 'transcribe.py');

function defaultCommandRunner(command, args, options = {}) {
  return spawnSync(command, args, {
    ...options,
    encoding: null,
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function assertCommandSuccess(result, command) {
  if (result.error || result.status !== 0) {
    throw new Error(`${command} 执行失败`);
  }
}

function probeLocalMedia(mediaPath, runCommand = defaultCommandRunner) {
  const result = runCommand(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_type,codec_name',
      '-of',
      'json',
      mediaPath,
    ],
    { timeout: FFPROBE_TIMEOUT_MS, killSignal: 'SIGKILL' },
  );
  assertCommandSuccess(result, 'ffprobe');
  const payload = JSON.parse(Buffer.from(result.stdout || '').toString('utf8'));
  const video = payload.streams?.find((stream) => stream.codec_type === 'video');
  const audio = payload.streams?.find((stream) => stream.codec_type === 'audio');
  const durationSec = Number(payload.format?.duration);
  if (!video?.codec_name || !Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error('媒体信息不完整');
  }
  const videoCodec = video.codec_name.toLowerCase();
  const audioCodec = audio?.codec_name?.toLowerCase() || '';
  const hasAudio = Boolean(audio);
  return {
    hasAudio,
    videoCodec,
    audioCodec,
    durationSec,
    needsTranscode: videoCodec !== 'h264' || (hasAudio && audioCodec !== 'aac'),
  };
}

function transcodeLocalMedia({
  app,
  mediaPath,
  workspace,
  runCommand = defaultCommandRunner,
}) {
  const outputPath = path.join(workspace, 'transcoded.mp4');
  const result = runCommand(
    'ffmpeg',
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      mediaPath,
      '-vf',
      "scale='min(1280,iw)':-2",
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '23',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      outputPath,
    ],
    { timeout: FFMPEG_TIMEOUT_MS, killSignal: 'SIGKILL' },
  );
  assertCommandSuccess(result, 'ffmpeg');
  return app
    .uploadFile({
      cloudPath: `video/processed/${crypto.randomUUID()}.mp4`,
      fileContent: fs.createReadStream(outputPath),
    })
    .then((uploaded) => {
      if (!uploaded?.fileID) {
        throw new Error('转码文件上传失败');
      }
      return { path: outputPath, uploadedFileId: uploaded.fileID };
    });
}

function transcribeLocalFile({
  mediaPath,
  durationSec,
  pythonCommand,
  modelName,
  runCommand = defaultCommandRunner,
}) {
  const manifestPath = path.join(path.dirname(mediaPath), 'worker-manifest.json');
  const manifest = {
    version: 1,
    entries: [
      {
        durationSec,
        media: { hasAudio: true },
        prepared: { media: path.basename(mediaPath) },
      },
    ],
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  const result = runCommand(
    pythonCommand,
    [
      TRANSCRIBE_SCRIPT,
      '--manifest',
      manifestPath,
      '--model',
      modelName,
      '--language',
      'zh',
    ],
    { timeout: TRANSCRIBE_TIMEOUT_MS, killSignal: 'SIGKILL' },
  );
  assertCommandSuccess(result, 'transcribe.py');
  const completed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).entries[0];
  const status = completed?.transcription?.status;
  return {
    ok: status === 'ready' || status === 'skipped',
    skipped: status === 'skipped',
    segments: Array.isArray(completed?.transcriptSegments)
      ? completed.transcriptSegments
      : [],
  };
}

async function callCatalog(app, data) {
  const response = await app.callFunction({ name: 'catalog', data });
  const result = response?.result ?? response;
  if (!result || result.ok !== true) {
    const error = new Error('catalog 调用失败');
    error.code =
      typeof result?.code === 'string' && result.code
        ? result.code
        : 'CATALOG_CALL_FAILED';
    throw error;
  }
  return result;
}

function createCatalog(app, initialTicket, adminPin) {
  let ticket = initialTicket;

  async function refreshTicket() {
    const login = await callCatalog(app, {
      action: 'adminLogin',
      pin: adminPin,
    });
    ticket = String(login.ticket || '');
  }

  async function authenticatedCall(data) {
    try {
      return await callCatalog(app, { ...data, ticket });
    } catch (error) {
      if (error?.code !== 'UNAUTHORIZED') {
        throw error;
      }
      await refreshTicket();
      return callCatalog(app, { ...data, ticket });
    }
  }

  return {
    claim: ({ workerId }) =>
      authenticatedCall({ action: 'claimVideoIngest', workerId }),
    complete: (payload) =>
      authenticatedCall({ action: 'completeVideoIngest', ...payload }),
  };
}

function defaultRequestUrl(url, onResponse) {
  const protocol = new URL(url).protocol;
  if (protocol === 'https:') {
    return https.get(url, onResponse);
  }
  if (protocol === 'http:') {
    return http.get(url, onResponse);
  }
  throw new Error('下载地址协议不受支持');
}

function startRequest(url, requestUrl) {
  let request;
  const response = new Promise((resolve, reject) => {
    request = requestUrl(url, resolve);
    request.once('error', reject);
  });
  return { request, response };
}

async function downloadVideoFile({
  app,
  fileId,
  workspace,
  requestUrl = defaultRequestUrl,
  downloadTimeoutMs = DOWNLOAD_TIMEOUT_MS,
}) {
  const localPath = path.join(workspace, 'input.mp4');
  const resolved = await app.getTempFileURL({ fileList: [fileId] });
  const file = resolved?.fileList?.[0];
  if (
    !file ||
    (file.code && file.code !== 'SUCCESS') ||
    typeof file.tempFileURL !== 'string' ||
    !file.tempFileURL
  ) {
    throw new Error('获取下载地址失败');
  }

  let request;
  let response;
  let totalTimeout;
  const timeoutError = new Error('下载超时');
  const destroyTransfer = () => {
    request?.destroy(timeoutError);
    response?.destroy(timeoutError);
  };
  try {
    const started = startRequest(file.tempFileURL, requestUrl);
    request = started.request;
    request.setTimeout(downloadTimeoutMs, destroyTransfer);
    const transfer = (async () => {
      response = await started.response;
      response.setTimeout(downloadTimeoutMs, destroyTransfer);
      if (
        !Number.isInteger(response.statusCode) ||
        response.statusCode < 200 ||
        response.statusCode >= 300
      ) {
        response.resume();
        throw new Error('下载响应失败');
      }
      await pipeline(
        response,
        fs.createWriteStream(localPath, { flags: 'wx', mode: 0o600 }),
      );
    })();
    transfer.catch(() => {});
    const timeout = new Promise((resolve, reject) => {
      totalTimeout = setTimeout(() => {
        destroyTransfer();
        reject(timeoutError);
      }, downloadTimeoutMs);
    });
    await Promise.race([transfer, timeout]);
  } catch {
    fs.rmSync(localPath, { force: true });
    throw new Error('下载文件失败');
  } finally {
    clearTimeout(totalTimeout);
  }

  const stat = fs.statSync(localPath);
  if (!stat.isFile() || stat.size === 0) {
    fs.rmSync(localPath, { force: true });
    throw new Error('下载文件为空');
  }
  return localPath;
}

function createJobDependencies({
  app,
  catalog,
  workerId,
  workspace,
  env,
  runCommand = defaultCommandRunner,
}) {
  let latestProbe;
  return {
    catalog,
    workerId,
    downloadVideo: (fileId) =>
      downloadVideoFile({ app, fileId, workspace }),
    probeMedia: async (mediaPath) => {
      latestProbe = probeLocalMedia(mediaPath, runCommand);
      return latestProbe;
    },
    transcodeIfNeeded: (mediaPath) =>
      transcodeLocalMedia({ app, mediaPath, workspace, runCommand }),
    transcribe: (mediaPath) =>
      transcribeLocalFile({
        mediaPath,
        durationSec: latestProbe.durationSec,
        pythonCommand:
          env.VIDEO_INGEST_PYTHON ||
          path.resolve('.video-ingest/venv/bin/python'),
        modelName: env.VIDEO_INGEST_ASR_MODEL || 'medium',
        runCommand,
      }),
    resolveAutoIntro,
    placeholderIntro: PLACEHOLDER_INTRO,
    now: Date.now,
  };
}

async function runInTemporaryWorkspace(work) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-video-worker-'));
  try {
    return await work(workspace);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function readCredentials(env) {
  return {
    envId: env.TCB_ENV_ID || '',
    secretId: env.TCB_SECRET_ID || '',
    secretKey: env.TCB_SECRET_KEY || '',
    adminPin: env.ADMIN_PIN || '',
  };
}

function hasAllCredentials(credentials) {
  return Object.values(credentials).every(Boolean);
}

async function runCli({
  env = process.env,
  stderr = process.stderr,
  createApp = (config) => cloudbase.init(config),
  maxIterations = Number.POSITIVE_INFINITY,
  wait = sleep,
} = {}) {
  const credentials = readCredentials(env);
  if (!hasAllCredentials(credentials)) {
    stderr.write('缺少云开发凭据\n');
    return 1;
  }

  try {
    const app = createApp({
      env: credentials.envId,
      secretId: credentials.secretId,
      secretKey: credentials.secretKey,
    });
    const login = await callCatalog(app, {
      action: 'adminLogin',
      pin: credentials.adminPin,
    });
    const catalog = createCatalog(
      app,
      String(login.ticket || ''),
      credentials.adminPin,
    );
    const workerId = `${os.hostname()}-${process.pid}`;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const result = await runInTemporaryWorkspace((workspace) =>
        runOnce(
          createJobDependencies({
            app,
            catalog,
            workerId,
            workspace,
            env,
          }),
        ),
      );
      if (result === 'idle' || result === 'failed') {
        await wait(IDLE_SLEEP_MS);
      }
    }
    return 0;
  } catch {
    stderr.write('worker 运行失败\n');
    return 1;
  }
}

if (require.main === module) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  downloadVideoFile,
  probeLocalMedia,
  runCli,
  runInTemporaryWorkspace,
  transcodeLocalMedia,
  transcribeLocalFile,
};
