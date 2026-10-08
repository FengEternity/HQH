#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { resolvePreparedFile } = require('./lib/importPlan');

const USAGE = '用法：replace-playback.js --manifest <manifest.json> [--dry-run | --execute]';
const CREDENTIAL_NAMES = {
  env: 'TCB_ENV_ID',
  secretId: 'TCB_SECRET_ID',
  secretKey: 'TCB_SECRET_KEY',
  adminPin: 'ADMIN_PIN',
};

function parseArguments(argv) {
  let manifestPath = '';
  let execute = false;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--execute') {
      execute = true;
      continue;
    }
    if (flag === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (flag === '--manifest' && argv[index + 1]) {
      manifestPath = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(USAGE);
  }

  if (!manifestPath) {
    throw new Error(USAGE);
  }
  if (execute && dryRun) {
    throw new Error('--dry-run 与 --execute 不能同时使用');
  }
  return { manifestPath, execute };
}

function readCredentials(env = process.env) {
  return {
    env: env.TCB_ENV_ID || '',
    secretId: env.TCB_SECRET_ID || '',
    secretKey: env.TCB_SECRET_KEY || '',
    adminPin: env.ADMIN_PIN || '',
  };
}

function assertCredentials(credentials) {
  const missing = Object.entries(CREDENTIAL_NAMES)
    .filter(([key]) => !credentials[key])
    .map(([, name]) => name);
  if (missing.length > 0) {
    throw new Error(`缺少运行时环境变量：${missing.join('、')}`);
  }
}

function readManifest(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest || !Array.isArray(manifest.entries)) {
    throw new Error('manifest 缺少 entries');
  }
  return manifest;
}

function safeError(error, credentials, manifestDirectory, ticket = '') {
  let message = String(error?.message || error || '未知错误');
  for (const value of [...Object.values(credentials), ticket]) {
    if (value) {
      message = message.split(value).join('[REDACTED]');
    }
  }
  if (manifestDirectory) {
    message = message.split(path.resolve(manifestDirectory)).join('[prepared]');
  }
  return message;
}

async function callCatalog(app, data) {
  const response = await app.callFunction({ name: 'catalog', data });
  const result = response?.result ?? response;
  if (!result || result.ok !== true) {
    const error = new Error(
      typeof result?.message === 'string' && result.message
        ? result.message
        : 'catalog 调用失败',
    );
    error.code = typeof result?.code === 'string' && result.code
      ? result.code
      : 'CATALOG_CALL_FAILED';
    throw error;
  }
  return result;
}

async function deleteCloudFile(app, fileId) {
  const result = await app.deleteFile({ fileList: [fileId] });
  if (
    !Array.isArray(result?.fileList) ||
    result.fileList.length !== 1 ||
    result.fileList[0]?.code !== 'SUCCESS'
  ) {
    throw new Error('云文件删除失败');
  }
}

async function listRemoteVideos(app, ticket) {
  const listed = await callCatalog(app, { action: 'adminListBrands', ticket });
  const videos = [];
  for (const brand of listed.brands || []) {
    const brandId = String(brand?._id || '').trim();
    if (!brandId) continue;
    const page = await callCatalog(app, {
      action: 'adminListVideos',
      ticket,
      brandId,
    });
    videos.push(...(page.videos || []));
  }
  return videos;
}

function buildPlan({ entries, videos, manifestDirectory }) {
  const ready = [];
  const rejected = [];

  for (const entry of entries) {
    const title = String(entry?.title || '').trim();
    const mediaPath = resolvePreparedFile(manifestDirectory, entry?.prepared?.media);
    const compliant = entry?.media?.playback?.compliant === true;
    const matches = videos.filter((video) => String(video?.title || '').trim() === title);
    if (!title || !mediaPath || !compliant || matches.length !== 1 || !matches[0]?.videoFileId) {
      rejected.push({ title: title || '(空标题)' });
      continue;
    }
    ready.push({
      title,
      videoId: matches[0]._id,
      oldVideoFileId: matches[0].videoFileId,
      localPath: entry.prepared.media,
      durationSec: entry.durationSec,
      media: entry.media,
    });
  }

  return { ready, rejected };
}

function writeLines(stdout, lines) {
  stdout.write(`${lines.filter((line) => line !== '').join('\n')}\n`);
}

function renderTitles(label, items) {
  if (items.length === 0) return '';
  return `${label}:\n${items.map((item) => item.title).join('\n')}`;
}

async function executePlan({
  app,
  ticket,
  ready,
  manifestDirectory,
  randomUUID,
}) {
  const succeeded = [];
  const failed = [];
  const warnings = [];

  for (const item of ready) {
    const absolutePath = resolvePreparedFile(manifestDirectory, item.localPath);
    let uploaded;
    try {
      uploaded = await app.uploadFile({
        cloudPath: `video/processed/${randomUUID()}.mp4`,
        fileContent: fs.createReadStream(absolutePath),
      });
      if (!uploaded?.fileID) {
        throw new Error('上传未返回 fileID');
      }
      await callCatalog(app, {
        action: 'replacePlaybackMedia',
        ticket,
        id: item.videoId,
        expectedVideoFileId: item.oldVideoFileId,
        videoFileId: uploaded.fileID,
        durationSec: item.durationSec,
        media: item.media,
      });
    } catch (error) {
      if (uploaded?.fileID) {
        try {
          await deleteCloudFile(app, uploaded.fileID);
        } catch {
          // 新文件删除失败不能掩盖替换失败，也不能删除旧文件。
        }
      }
      failed.push({ title: item.title, error });
      continue;
    }

    try {
      await deleteCloudFile(app, item.oldVideoFileId);
    } catch {
      warnings.push({ title: item.title });
    }
    succeeded.push({ title: item.title });
  }

  return { succeeded, failed, warnings };
}

function createCloudbaseApp(config) {
  const cloudbase = require('@cloudbase/node-sdk');
  return cloudbase.init(config);
}

async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  createApp = createCloudbaseApp,
  randomUUID = () => crypto.randomUUID(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const credentials = readCredentials(env);
  let manifestDirectory = '';
  let ticket = '';

  try {
    const options = parseArguments(argv);
    assertCredentials(credentials);
    const absoluteManifestPath = path.resolve(options.manifestPath);
    manifestDirectory = path.dirname(absoluteManifestPath);
    const manifest = readManifest(absoluteManifestPath);
    const app = createApp({
      env: credentials.env,
      secretId: credentials.secretId,
      secretKey: credentials.secretKey,
    });
    const login = await callCatalog(app, {
      action: 'adminLogin',
      pin: credentials.adminPin,
    });
    ticket = String(login.ticket || '');
    const videos = await listRemoteVideos(app, ticket);
    const plan = buildPlan({
      entries: manifest.entries,
      videos,
      manifestDirectory,
    });

    if (!options.execute) {
      writeLines(stdout, [
        `ready ${plan.ready.length}，rejected ${plan.rejected.length}，failed 0，warning 0`,
        renderTitles('ready', plan.ready),
        renderTitles('rejected', plan.rejected),
      ]);
      return plan.rejected.length > 0 ? 1 : 0;
    }

    const result = await executePlan({
      app,
      ticket,
      ready: plan.ready,
      manifestDirectory,
      randomUUID,
    });
    writeLines(stdout, [
      `succeeded ${result.succeeded.length}，failed ${result.failed.length}，rejected ${plan.rejected.length}，warning ${result.warnings.length}`,
      renderTitles('succeeded', result.succeeded),
      renderTitles('failed', result.failed),
      renderTitles('rejected', plan.rejected),
      renderTitles('warning', result.warnings),
    ]);
    return result.failed.length > 0 || plan.rejected.length > 0 ? 1 : 0;
  } catch (error) {
    stderr.write(`${safeError(error, credentials, manifestDirectory, ticket)}\n`);
    return 1;
  }
}

if (require.main === module) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  runCli,
};
