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

function safeError(error, credentials, manifestDirectory) {
  let message = String(error?.message || error || '未知错误');
  for (const value of Object.values(credentials)) {
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
    writeManifest(manifestPath, manifest);
    return true;
  } catch (error) {
    entry.import.status = 'failed';
    entry.import[checkpoint] = {
      status: 'failed',
      error: safeError(error, credentials, manifestDirectory),
    };
    writeManifest(manifestPath, manifest);
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
    });
    if (!uploaded) {
      return false;
    }
  }

  try {
    const payload = buildDraftPayload(entry, {
      brandId,
      coverFileId: entry.import.cover.fileId,
      videoFileId: entry.import.video.fileId,
    });
    const saved = await callCatalog(app, {
      action: 'upsertVideo',
      ticket,
      ...payload,
    });
    entry.import.draft = { status: 'success', videoId: saved.id };
    entry.import.status = 'success';
    writeManifest(manifestPath, manifest);
    return true;
  } catch (error) {
    entry.import.status = 'failed';
    entry.import.draft = {
      status: 'failed',
      error: safeError(error, credentials, manifestDirectory),
    };
    writeManifest(manifestPath, manifest);
    return false;
  }
}

async function executeImport({ manifestPath, credentials, createApp }) {
  assertCredentials(credentials);
  const absoluteManifestPath = path.resolve(manifestPath);
  const manifestDirectory = path.dirname(absoluteManifestPath);
  const manifest = readManifest(absoluteManifestPath);
  const plan = buildImportPlan({ entries: manifest.entries, manifestDirectory });
  if (plan.rejected.length > 0) {
    throw new Error(`有 ${plan.rejected.length} 条未通过本地导入闸门`);
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
  return buildImportPlan({
    entries: manifest.entries,
    manifestDirectory: path.dirname(absoluteManifestPath),
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.execute) {
    const plan = dryRun(options.manifestPath);
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: 'dry-run',
          draftCount: plan.ready.length,
          rejectedCount: plan.rejected.length,
          skippedCount: plan.skipped.length,
          drafts: plan.ready,
          rejected: plan.rejected,
          skipped: plan.skipped,
        },
        null,
        2,
      )}\n`,
    );
    if (plan.rejected.length > 0) {
      process.exitCode = 1;
    }
    return;
  }

  const result = await executeImport({
    manifestPath: options.manifestPath,
    credentials: readCredentials(),
    createApp: createCloudbaseApp,
  });
  process.stdout.write(
    `执行完成：成功 ${result.succeeded} 条，失败 ${result.failed} 条，跳过 ${result.skipped} 条\n`,
  );
  if (result.failed > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  dryRun,
  executeImport,
  parseArguments,
  readCredentials,
};
