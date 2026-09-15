#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cloudbase = require('@cloudbase/node-sdk');

const { PLACEHOLDER_INTRO, resolveAutoIntro } = require('./lib/autoIntro');
const { runOnce } = require('./lib/workerLoop');

const IDLE_SLEEP_MS = 5000;
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
  const result = runCommand('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=codec_type,codec_name',
    '-of',
    'json',
    mediaPath,
  ]);
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
  const result = runCommand('ffmpeg', [
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
  ]);
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
  const result = runCommand(pythonCommand, [
    TRANSCRIBE_SCRIPT,
    '--manifest',
    manifestPath,
    '--model',
    modelName,
    '--language',
    'zh',
  ]);
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
    throw new Error('catalog 调用失败');
  }
  return result;
}

function createCatalog(app, ticket) {
  return {
    claim: ({ workerId }) =>
      callCatalog(app, { action: 'claimVideoIngest', ticket, workerId }),
    complete: (payload) =>
      callCatalog(app, { action: 'completeVideoIngest', ticket, ...payload }),
  };
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
    downloadVideo: async (fileId) => {
      const localPath = path.join(workspace, 'input.mp4');
      const downloaded = await app.downloadFile({
        fileID: fileId,
        tempFilePath: localPath,
      });
      if (!fs.existsSync(localPath) && downloaded?.fileContent !== undefined) {
        fs.writeFileSync(localPath, downloaded.fileContent, { mode: 0o600 });
      }
      const stat = fs.statSync(localPath);
      if (!stat.isFile() || stat.size === 0) {
        throw new Error('下载文件为空');
      }
      return localPath;
    },
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
    const catalog = createCatalog(app, String(login.ticket || ''));
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
      if (result === 'idle') {
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
  probeLocalMedia,
  runCli,
  runInTemporaryWorkspace,
  transcribeLocalFile,
};
