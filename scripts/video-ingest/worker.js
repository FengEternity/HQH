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

const { transcribeSpeech, writeIntroText, resolveTencentConfig } = require('./lib/tencentSpeech');
const { PLACEHOLDER_INTRO } = require('./lib/autoIntro');
const {
  INTRO_SYSTEM_PROMPT,
  acceptIntro,
  buildIntroUserPrompt,
  joinTranscript,
} = require('./lib/introAbstract');
const {
  assessPlaybackProfile,
  buildPlaybackFfmpegArgs,
  probePlaybackMedia,
  toPlaybackMetadata,
} = require('./lib/playbackProfile');
const { runOnce } = require('./lib/workerLoop');

const IDLE_SLEEP_MS = 5000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const FFPROBE_TIMEOUT_MS = 30 * 1000;
const DEFAULT_FFMPEG_TIMEOUT_MS = 30 * 60 * 1000;

function ffmpegTimeoutMs(env = process.env) {
  const parsed = Number(env.FFMPEG_TIMEOUT_MS);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_FFMPEG_TIMEOUT_MS;
}

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
  const probed = probePlaybackMedia(
    mediaPath,
    (command, args, options) =>
      runCommand(command, args, {
        ...options,
        timeout: FFPROBE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      }),
  );
  // 与 lib/manifest.js 及云端 normalizeVideoMedia 保持同一精度：先按一位小数定稿，
  // 转写才不会产出超过云端时长上界的 endSec，complete 也就不会被判 BAD_INPUT。
  const probe = {
    ...probed,
    durationSec: Math.round(probed.durationSec * 10) / 10,
  };
  if (probe.durationSec <= 0) {
    throw new Error('媒体信息不完整');
  }
  const assessment = assessPlaybackProfile(probe);
  return {
    ...probe,
    needsTranscode: !assessment.compliant,
    playback: toPlaybackMetadata(probe),
  };
}

async function publishSpeechAudio({ app, audioPath }) {
  const uploaded = await app.uploadFile({
    cloudPath: `asr-temp/${crypto.randomUUID()}.m4a`,
    fileContent: fs.createReadStream(audioPath),
  });
  const fileId = uploaded && uploaded.fileID;
  if (!fileId) {
    throw new Error('转写音频上传失败');
  }
  try {
    const resolved = await app.getTempFileURL({ fileList: [fileId] });
    const file = resolved?.fileList?.[0];
    const url = file && typeof file.tempFileURL === 'string' ? file.tempFileURL : '';
    if (!url || (file.code && file.code !== 'SUCCESS')) {
      throw new Error('获取转写音频地址失败');
    }
    return { fileId, url };
  } catch (error) {
    try {
      await deleteCloudFiles(app, [fileId]);
    } catch {
      // 地址没取到时尽量清掉临时音轨
    }
    throw error;
  }
}

function extractSpeechAudio({
  mediaPath,
  workspace,
  runCommand = defaultCommandRunner,
}) {
  const outputPath = path.join(workspace, 'speech.m4a');
  const result = runCommand(
    'ffmpeg',
    [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', mediaPath,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '64k',
      outputPath,
    ],
    { timeout: 3 * 60 * 1000, killSignal: 'SIGKILL' },
  );
  assertCommandSuccess(result, 'ffmpeg');
  return outputPath;
}

function transcodeLocalMedia({
  app,
  mediaPath,
  workspace,
  probe,
  runCommand = defaultCommandRunner,
}) {
  const outputPath = path.join(workspace, 'transcoded.mp4');
  const result = runCommand(
    'ffmpeg',
    buildPlaybackFfmpegArgs(mediaPath, outputPath, probe),
    { timeout: ffmpegTimeoutMs(), killSignal: 'SIGKILL' },
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

async function createVideoCover({
  app,
  mediaPath,
  workspace,
  durationSec,
  runCommand = defaultCommandRunner,
}) {
  const outputPath = path.join(workspace, 'auto-cover.jpg');
  const duration = Number(durationSec);
  const firstSeek = Number.isFinite(duration) && duration > 0
    ? Math.min(1, duration / 2)
    : 1;
  const fallbackSeek = Number.isFinite(duration) && duration > 0
    ? (duration >= 3 ? 3 : duration / 2)
    : 3;
  const seekPoints = firstSeek === fallbackSeek
    ? [firstSeek]
    : [firstSeek, fallbackSeek];

  let created = false;
  for (const seekSec of seekPoints) {
    fs.rmSync(outputPath, { force: true });
    const result = runCommand(
      'ffmpeg',
      [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', String(seekSec),
        '-i', mediaPath,
        '-frames:v', '1',
        '-vf', 'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720',
        '-q:v', '2',
        outputPath,
      ],
      { timeout: 3 * 60 * 1000, killSignal: 'SIGKILL' },
    );
    const stat = fs.existsSync(outputPath) ? fs.statSync(outputPath) : null;
    if (!result.error && result.status === 0 && stat?.isFile() && stat.size > 0) {
      created = true;
      break;
    }
  }
  if (!created) {
    throw new Error('自动封面生成失败');
  }

  const uploaded = await app.uploadFile({
    cloudPath: `cover/auto/${crypto.randomUUID()}.jpg`,
    fileContent: fs.createReadStream(outputPath),
  });
  if (!uploaded?.fileID) {
    throw new Error('自动封面上传失败');
  }
  return uploaded.fileID;
}

function loadTermDocument() {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, 'terms.zh-CN.json'), 'utf8'),
  );
}


async function callCatalog(app, data) {
  const response = await app.callFunction({ name: 'catalog', data });
  const result = response?.result ?? response;
  if (!result || result.ok !== true) {
    const message = typeof result?.message === 'string' && result.message
      ? result.message
      : 'catalog 调用失败';
    const error = new Error(message);
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
    noteIntro: (payload) =>
      authenticatedCall({ action: 'noteVideoIntro', ...payload }),
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

async function deleteCloudFiles(app, fileIds) {
  if (fileIds.length === 0) {
    return;
  }
  const result = await app.deleteFile({ fileList: fileIds });
  if (
    !Array.isArray(result?.fileList) ||
    result.fileList.length !== fileIds.length ||
    result.fileList.some((file) => file?.code !== 'SUCCESS')
  ) {
    throw new Error('云文件删除失败');
  }
}

function createJobDependencies({
  app,
  catalog,
  workerId,
  workspace,
  env,
  stderr = process.stderr,
  runCommand = defaultCommandRunner,
}) {
  const termDocument = loadTermDocument();
  return {
    catalog,
    workerId,
    downloadVideo: (fileId) =>
      downloadVideoFile({ app, fileId, workspace }),
    probeMedia: async (mediaPath) => probeLocalMedia(mediaPath, runCommand),
    transcodeIfNeeded: (mediaPath, probe) =>
      transcodeLocalMedia({ app, mediaPath, workspace, probe, runCommand }),
    createCover: (mediaPath, probe) =>
      createVideoCover({
        app,
        mediaPath,
        workspace,
        durationSec: probe.durationSec,
        runCommand,
      }),
    recognizeSpeech: resolveTencentConfig(env)
      ? async ({ localPath, title, brandName, durationSec }) => {
        const log = (line) => stderr.write(`${line}\n`);
        const speechConfig = resolveTencentConfig(env);
        if (!speechConfig.asrEngine || !speechConfig.region) {
          throw new Error('缺少腾讯云语音识别配置');
        }
        const audioPath = extractSpeechAudio({ mediaPath: localPath, workspace, runCommand });
        log(`tencent asr: start ${speechConfig.asrEngine}`);
        const published = await publishSpeechAudio({ app, audioPath });
        let segments;
        try {
          segments = await transcribeSpeech({
            env,
            audioUrl: published.url,
            durationSec,
          });
        } finally {
          try {
            await deleteCloudFiles(app, [published.fileId]);
          } catch {
            log('转写音频清理失败');
          }
        }
        log('tencent asr: ready');
        if (!speechConfig.introKey || !speechConfig.introModel || !speechConfig.chatUrl) {
          log('tencent intro skipped: missing config');
          return { segments, intro: '', grounded: false };
        }
        let intro = '';
        try {
          intro = await writeIntroText({
            env,
            systemPrompt: INTRO_SYSTEM_PROMPT,
            userPrompt: buildIntroUserPrompt({
              title,
              brandName,
              transcript: joinTranscript(segments),
              terms: termDocument.terms,
            }),
          });
        } catch (error) {
          log(`tencent intro skipped: ${error && error.message ? error.message : 'failed'}`);
          return { segments, intro: '', grounded: false };
        }
        const verdict = acceptIntro({
          intro,
          title,
          brandName,
          transcript: joinTranscript(segments),
          terms: termDocument.terms,
          brandNames: termDocument.brandNames,
          placeholderIntro: PLACEHOLDER_INTRO,
        });
        log(`tencent intro: ${intro}`);
        log(verdict.ok
          ? 'tencent intro accepted'
          : `tencent intro kept, gate rejected ${verdict.reason || 'unknown'}`);
        const kept = verdict.intro && verdict.intro !== PLACEHOLDER_INTRO ? verdict.intro : '';
        return {
          segments,
          intro: kept,
          grounded: verdict.ok === true,
          gateOk: verdict.ok === true,
          gateReason: verdict.ok ? '' : (verdict.reason || ''),
        };
      }
      : undefined,
    now: Date.now,
    deleteCloudFiles: (fileIds) => deleteCloudFiles(app, fileIds),
    warn: (message) => {
      stderr.write(`${message || '云文件清理失败'}\n`);
    },
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
            stderr,
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
  callCatalog,
  createCatalog,
  createJobDependencies,
  createVideoCover,
  deleteCloudFiles,
  downloadVideoFile,
  hasAllCredentials,
  probeLocalMedia,
  readCredentials,
  runCli,
  runInTemporaryWorkspace,
  transcodeLocalMedia,
};
