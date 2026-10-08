#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { writeJsonAtomic } = require('./lib/atomicJson');
const { resolvePreparedFile } = require('./lib/importPlan');
const {
  assessPlaybackProfile,
  buildPlaybackFfmpegArgs,
  probePlaybackMedia,
  toPlaybackMetadata,
} = require('./lib/playbackProfile');

const USAGE = '用法：normalize-prepared.js --manifest <manifest.json>';

function defaultCommandRunner(command, args, options = {}) {
  return spawnSync(command, args, {
    ...options,
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function readManifest(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest || !Array.isArray(manifest.entries)) {
    throw new Error('manifest 缺少 entries');
  }
  return manifest;
}

function applyProbe(entry, filePath, probe, { transcoded }) {
  entry.durationSec = Math.round(probe.durationSec * 10) / 10;
  entry.media = {
    videoCodec: probe.videoCodec,
    audioCodec: probe.audioCodec,
    hasAudio: probe.hasAudio,
    playback: toPlaybackMetadata(probe),
  };
  entry.prepared = {
    ...entry.prepared,
    mediaSha256: hashFile(filePath),
  };
  if (transcoded) {
    entry.transcodeRequired = true;
  }
}

function assertCommandSuccess(result, command) {
  if (result.error) {
    throw new Error(`${command} 启动失败：${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = Buffer.from(result.stderr || '').toString('utf8').trim();
    throw new Error(`${command} 执行失败${detail ? `：${detail}` : ''}`);
  }
}

function transcodePrepared(mediaPath, relativeMedia, probe, runCommand) {
  const slug = path.basename(relativeMedia, path.extname(relativeMedia));
  const temporaryPath = path.join(path.dirname(mediaPath), `${slug}.normalizing.mp4`);
  try {
    const result = runCommand(
      'ffmpeg',
      buildPlaybackFfmpegArgs(mediaPath, temporaryPath, probe),
      { encoding: null, shell: false },
    );
    assertCommandSuccess(result, 'ffmpeg');
    const outputProbe = probePlaybackMedia(temporaryPath, runCommand);
    const assessment = assessPlaybackProfile(outputProbe);
    if (!assessment.compliant) {
      throw new Error(`转码产物不符合播放规格：${assessment.reasons.join(',')}`);
    }
    fs.renameSync(temporaryPath, mediaPath);
    return outputProbe;
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function normalizePrepared({ manifestPath, runCommand = defaultCommandRunner }) {
  const absoluteManifestPath = path.resolve(manifestPath);
  const manifestDirectory = path.dirname(absoluteManifestPath);
  const manifest = readManifest(absoluteManifestPath);
  const counts = { compliant: 0, transcoded: 0, failed: 0 };

  for (const entry of manifest.entries) {
    const relativeMedia = entry?.prepared?.media;
    const mediaPath = resolvePreparedFile(manifestDirectory, relativeMedia);
    if (!mediaPath) {
      counts.failed += 1;
      continue;
    }

    let probe;
    try {
      probe = probePlaybackMedia(mediaPath, runCommand);
    } catch {
      counts.failed += 1;
      continue;
    }

    if (assessPlaybackProfile(probe).compliant) {
      applyProbe(entry, mediaPath, probe, { transcoded: false });
      counts.compliant += 1;
      continue;
    }

    try {
      const outputProbe = transcodePrepared(mediaPath, relativeMedia, probe, runCommand);
      applyProbe(entry, mediaPath, outputProbe, { transcoded: true });
      counts.transcoded += 1;
    } catch {
      counts.failed += 1;
    }
  }

  writeJsonAtomic(absoluteManifestPath, manifest);
  return counts;
}

function parseArguments(argv) {
  let manifestPath = '';
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--manifest' && argv[index + 1]) {
      manifestPath = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(USAGE);
  }
  if (!manifestPath) {
    throw new Error(USAGE);
  }
  return { manifestPath };
}

function runCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  runCommand = defaultCommandRunner,
} = {}) {
  try {
    const { manifestPath } = parseArguments(argv);
    const result = normalizePrepared({ manifestPath, runCommand });
    stdout.write(
      `合格 ${result.compliant}，重编码 ${result.transcoded}，失败 ${result.failed}\n`,
    );
    return result.failed > 0 ? 1 : 0;
  } catch (error) {
    stderr.write(`${error.message || '归一化失败'}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runCli();
}

module.exports = {
  normalizePrepared,
  runCli,
};
