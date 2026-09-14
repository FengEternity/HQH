#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
  buildDraftPayload,
  buildImportPlan,
  resolvePreparedFile,
} = require('./lib/importPlan');

const USAGE = '用法：import.js --manifest <manifest.json> [--dry-run | --execute]';
const CREDENTIAL_NAMES = {
  env: 'TCB_ENV_ID',
  secretId: 'TCB_SECRET_ID',
  secretKey: 'TCB_SECRET_KEY',
  adminPin: 'ADMIN_PIN',
};
const DRY_RUN_WARNINGS = [
  'brandId、coverFileId、videoFileId 为 dry-run 占位符，不是可写入值',
  'manifest 是 execute 的幂等凭据；请先备份，丢失后不可从零重跑 execute',
];

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

function readManifest(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest || !Array.isArray(manifest.entries)) {
    throw new Error('manifest 缺少 entries');
  }
  return manifest;
}

function writeManifest(manifestPath, manifest) {
  const temporaryPath = `${manifestPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, manifestPath);
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

function hasFailures(summary) {
  return Number(summary.failed || 0) > 0 || Number(summary.rejected || 0) > 0;
}

function safeError(error, credentials, manifestDirectory, ticket = '') {
  let message = String(error?.message || error || '未知错误');
  for (const value of [...Object.values(credentials), ticket]) {
    if (value) {
      message = message.split(value).join('[REDACTED]');
    }
  }
  const absoluteDirectory = path.resolve(manifestDirectory);
  message = message.split(absoluteDirectory).join('[prepared]');
  return message;
}

async function callCatalog(app, data) {
  const response = await app.callFunction({ name: 'catalog', data });
  const result = response?.result ?? response;
  if (!result || result.ok !== true) {
    const error = new Error(result?.message || 'catalog 调用失败');
    error.code = result?.code || 'CATALOG_CALL_FAILED';
    error.remoteRejected = true;
    throw error;
  }
  return result;
}

async function uploadCheckpoint({
  app,
  entry,
  checkpoint,
  cloudPath,
  localPath,
  manifest,
  manifestPath,
  credentials,
  manifestDirectory,
  ticket,
  persistManifest,
}) {
  try {
    const result = await app.uploadFile({
      cloudPath,
      fileContent: fs.createReadStream(localPath),
    });
    if (!result?.fileID) {
      throw new Error(`上传 ${checkpoint} 未返回 fileID`);
    }
    entry.import[checkpoint] = { status: 'success', fileId: result.fileID };
    persistManifest(manifestPath, manifest);
    return true;
  } catch (error) {
    entry.import.status = 'failed';
    entry.import[checkpoint] = {
      status: 'failed',
      error: safeError(error, credentials, manifestDirectory, ticket),
    };
    persistManifest(manifestPath, manifest);
    return false;
  }
}

async function ensureBrands(app, ticket, names) {
  const listed = await callCatalog(app, { action: 'adminListBrands', ticket });
  const brands = new Map((listed.brands || []).map((brand) => [brand.name, brand._id]));
  let nextSort = brands.size;

  for (const name of names) {
    if (brands.has(name)) {
      continue;
    }
    const created = await callCatalog(app, {
      action: 'upsertBrand',
      ticket,
      name,
      sort: nextSort,
    });
    brands.set(name, created.id);
    nextSort += 1;
  }
  return brands;
}

async function importEntry({
  app,
  ticket,
  brandId,
  entry,
  manifest,
  manifestPath,
  credentials,
  manifestDirectory,
  persistManifest,
}) {
  entry.import = entry.import || { status: 'pending' };
  entry.import.status = 'pending';

  const coverPath = resolvePreparedFile(manifestDirectory, entry.prepared.cover);
  const mediaPath = resolvePreparedFile(manifestDirectory, entry.prepared.media);
  if (entry.import.cover?.status !== 'success') {
    const uploaded = await uploadCheckpoint({
      app,
      entry,
      checkpoint: 'cover',
      cloudPath: `cover/${entry.sourceKey}.jpg`,
      localPath: coverPath,
      manifest,
      manifestPath,
      credentials,
      manifestDirectory,
      ticket,
      persistManifest,
    });
    if (!uploaded) {
      return false;
    }
  }
  if (entry.import.video?.status !== 'success') {
    const uploaded = await uploadCheckpoint({
      app,
      entry,
      checkpoint: 'video',
      cloudPath: `video/${entry.sourceKey}.mp4`,
      localPath: mediaPath,
      manifest,
      manifestPath,
      credentials,
      manifestDirectory,
      ticket,
      persistManifest,
    });
    if (!uploaded) {
      return false;
    }
  }

  const previousVideoId = entry.import.draft?.videoId;
  const payload = buildDraftPayload(entry, {
    brandId,
    coverFileId: entry.import.cover.fileId,
    videoFileId: entry.import.video.fileId,
    videoId: previousVideoId,
  });
  entry.import.draft = {
    status: 'inflight',
    ...(previousVideoId ? { videoId: previousVideoId } : {}),
  };
  persistManifest(manifestPath, manifest);

  try {
    const saved = await callCatalog(app, {
      action: 'upsertVideo',
      ticket,
      ...payload,
    });
    if (!String(saved.id || '').trim()) {
      throw new Error('upsertVideo 成功响应缺少 id');
    }
    entry.import.draft = { status: 'success', videoId: saved.id };
    entry.import.status = 'success';
    persistManifest(manifestPath, manifest);
    return true;
  } catch (error) {
    entry.import.status = 'failed';
    entry.import.draft = {
      status: error.remoteRejected ? 'failed' : 'inflight',
      ...(entry.import.draft?.videoId ? { videoId: entry.import.draft.videoId } : {}),
      error: safeError(error, credentials, manifestDirectory, ticket),
    };
    persistManifest(manifestPath, manifest);
    return false;
  }
}

async function executeImport({
  manifestPath,
  credentials,
  createApp,
  persistManifest = writeManifest,
  runtime = {},
}) {
  assertCredentials(credentials);
  const absoluteManifestPath = path.resolve(manifestPath);
  const manifestDirectory = path.dirname(absoluteManifestPath);
  const manifest = readManifest(absoluteManifestPath);
  const plan = buildImportPlan({ entries: manifest.entries, manifestDirectory });
  if (plan.ready.length === 0) {
    return {
      succeeded: 0,
      failed: 0,
      rejected: plan.rejected.length,
      skipped: plan.skipped.length,
    };
  }

  const app = createApp({
    env: credentials.env,
    secretId: credentials.secretId,
    secretKey: credentials.secretKey,
  });
  const login = await callCatalog(app, {
    action: 'adminLogin',
    pin: credentials.adminPin,
  });
  runtime.ticket = String(login.ticket || '');
  const brandNames = [...new Set(plan.ready.map((item) => item.brandName))].sort((left, right) =>
    left.localeCompare(right, 'zh-CN'),
  );
  const brands = await ensureBrands(app, login.ticket, brandNames);
  let succeeded = 0;
  let failed = 0;

  for (const item of plan.ready) {
    const entry = manifest.entries.find((candidate) => candidate.sourceKey === item.sourceKey);
    const success = await importEntry({
      app,
      ticket: login.ticket,
      brandId: brands.get(entry.brandName),
      entry,
      manifest,
      manifestPath: absoluteManifestPath,
      credentials,
      manifestDirectory,
      persistManifest,
    });
    if (success) {
      succeeded += 1;
    } else {
      failed += 1;
    }
  }

  return {
    succeeded,
    failed,
    rejected: plan.rejected.length,
    skipped: plan.skipped.length,
  };
}

function createCloudbaseApp(config) {
  const cloudbase = require('@cloudbase/node-sdk');
  return cloudbase.init(config);
}

function dryRun(manifestPath) {
  const absoluteManifestPath = path.resolve(manifestPath);
  const manifest = readManifest(absoluteManifestPath);
  const plan = buildImportPlan({
    entries: manifest.entries,
    manifestDirectory: path.dirname(absoluteManifestPath),
  });
  return { ...plan, warnings: [...DRY_RUN_WARNINGS] };
}

async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  createApp = createCloudbaseApp,
  persistManifest = writeManifest,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const credentials = readCredentials(env);
  const runtime = { ticket: '' };
  let manifestDirectory = process.cwd();

  try {
    const options = parseArguments(argv);
    manifestDirectory = path.dirname(path.resolve(options.manifestPath));
    if (!options.execute) {
      const plan = dryRun(options.manifestPath);
      stdout.write(
        `${JSON.stringify(
          {
            mode: 'dry-run',
            draftCount: plan.ready.length,
            rejectedCount: plan.rejected.length,
            skippedCount: plan.skipped.length,
            warnings: plan.warnings,
            drafts: plan.ready,
            rejected: plan.rejected,
            skipped: plan.skipped,
          },
          null,
          2,
        )}\n`,
      );
      return hasFailures({ rejected: plan.rejected.length }) ? 1 : 0;
    }

    const result = await executeImport({
      manifestPath: options.manifestPath,
      credentials,
      createApp,
      persistManifest,
      runtime,
    });
    stdout.write(
      `执行完成：成功 ${result.succeeded} 条，失败 ${result.failed} 条，` +
        `拒绝 ${result.rejected} 条，跳过 ${result.skipped} 条\n`,
    );
    return hasFailures(result) ? 1 : 0;
  } catch (error) {
    stderr.write(
      `${safeError(error, credentials, manifestDirectory, runtime.ticket)}\n`,
    );
    return 1;
  }
}

if (require.main === module) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  dryRun,
  executeImport,
  hasFailures,
  parseArguments,
  readCredentials,
  runCli,
};
