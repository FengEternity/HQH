#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { writeJsonAtomic } = require('./lib/atomicJson');
const {
  buildManifestEntry,
  selectCandidates,
} = require('./lib/manifest');
const {
  assessPlaybackProfile,
  buildPlaybackFfmpegArgs,
  probePlaybackMedia,
  toPlaybackMetadata,
} = require('./lib/playbackProfile');
const content = require('./content.zh-CN.json');

function defaultCommandRunner(command, args, options = {}) {
  return spawnSync(command, args, {
    ...options,
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });
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

function checkMediaTools(runCommand) {
  for (const command of ['ffprobe', 'ffmpeg']) {
    const result = runCommand(command, ['-version'], { encoding: null, shell: false });
    assertCommandSuccess(result, command);
  }
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

function scanMp4Files(inputDirectory) {
  const files = [];

  function visit(directory) {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.mp4') {
        files.push({
          absolutePath,
          relativePath: path.relative(inputDirectory, absolutePath).split(path.sep).join('/'),
          sha256: hashFile(absolutePath),
        });
      }
    }
  }

  visit(inputDirectory);
  return files;
}

function runFfmpeg(args, runCommand) {
  const result = runCommand('ffmpeg', args, { encoding: null, shell: false });
  assertCommandSuccess(result, 'ffmpeg');
}

function prepareMedia(
  sourcePath,
  destinationPath,
  probe,
  outputDirectory,
  runCommand,
) {
  const canonicalDestination = resolveCanonicalPath(destinationPath);
  if (!containsPath(outputDirectory, canonicalDestination)) {
    throw new Error('prepared 媒体路径超出已验证输出目录');
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.rmSync(destinationPath, { force: true });
  if (assessPlaybackProfile(probe).compliant) {
    fs.copyFileSync(sourcePath, destinationPath);
    fs.chmodSync(
      destinationPath,
      fs.statSync(destinationPath).mode | 0o200,
    );
    return;
  }

  runFfmpeg(
    buildPlaybackFfmpegArgs(sourcePath, destinationPath, probe),
    runCommand,
  );
  fs.chmodSync(
    destinationPath,
    fs.statSync(destinationPath).mode | 0o200,
  );
}

function isNonEmptyFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function extractCover(mediaPath, coverPath, seekSec, runCommand) {
  fs.rmSync(coverPath, { force: true });
  runFfmpeg(
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      String(seekSec),
      '-i',
      mediaPath,
      '-frames:v',
      '1',
      coverPath,
    ],
    runCommand,
  );
}

function extractImages(
  mediaPath,
  coverPath,
  keyframesDirectory,
  durationSec,
  runCommand,
) {
  fs.mkdirSync(path.dirname(coverPath), { recursive: true });
  fs.rmSync(keyframesDirectory, { recursive: true, force: true });
  fs.mkdirSync(keyframesDirectory, { recursive: true });

  extractCover(mediaPath, coverPath, 1, runCommand);
  if (!isNonEmptyFile(coverPath)) {
    const fallbackSec =
      durationSec >= 3
        ? 3
        : Number((durationSec / 2).toFixed(3));
    extractCover(mediaPath, coverPath, fallbackSec, runCommand);
  }
  if (!isNonEmptyFile(coverPath)) {
    throw new Error(`封面提取失败：${path.basename(mediaPath)}`);
  }

  runFfmpeg(
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      mediaPath,
      '-vf',
      'fps=1/8',
      path.join(keyframesDirectory, '%04d.jpg'),
    ],
    runCommand,
  );
  const keyframes = fs
    .readdirSync(keyframesDirectory)
    .filter(
      (fileName) =>
        path.extname(fileName).toLowerCase() === '.jpg' &&
        isNonEmptyFile(path.join(keyframesDirectory, fileName)),
    );
  if (keyframes.length === 0) {
    throw new Error(`关键帧提取失败：${path.basename(mediaPath)}`);
  }
}

function resolveCanonicalPath(targetPath) {
  let existingAncestor = path.resolve(targetPath);
  const missingSegments = [];
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      break;
    }
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }

  return path.join(fs.realpathSync(existingAncestor), ...missingSegments);
}

function containsPath(parent, child) {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function validateDirectories(inputDirectory, outputDirectory) {
  const input = resolveCanonicalPath(inputDirectory);
  const output = resolveCanonicalPath(outputDirectory);
  if (containsPath(input, output) || containsPath(output, input)) {
    throw new Error('输入与输出目录不得相同或互相包含');
  }
  return { input, output };
}

function preprocess({
  inputDirectory,
  outputDirectory,
  runCommand = defaultCommandRunner,
}) {
  const directories = validateDirectories(inputDirectory, outputDirectory);
  checkMediaTools(runCommand);
  fs.mkdirSync(directories.output, { recursive: true });

  const candidates = selectCandidates(scanMp4Files(directories.input));
  const entries = [];
  for (const file of candidates) {
    const probe = probePlaybackMedia(file.absolutePath, runCommand);
    const entry = buildManifestEntry(file, probe, content);
    const mediaPath = path.join(directories.output, entry.prepared.media);
    const coverPath = path.join(directories.output, entry.prepared.cover);
    const keyframesDirectory = path.join(
      directories.output,
      entry.prepared.keyframes,
    );

    prepareMedia(
      file.absolutePath,
      mediaPath,
      probe,
      directories.output,
      runCommand,
    );
    const preparedProbe = probePlaybackMedia(mediaPath, runCommand);
    const preparedAssessment = assessPlaybackProfile(preparedProbe);
    if (!preparedAssessment.compliant) {
      throw new Error(
        `转码产物不符合播放规格：${preparedAssessment.reasons.join(',')}`,
      );
    }
    entry.durationSec = Math.round(preparedProbe.durationSec * 10) / 10;
    entry.media = {
      videoCodec: preparedProbe.videoCodec,
      audioCodec: preparedProbe.audioCodec,
      hasAudio: preparedProbe.hasAudio,
      playback: toPlaybackMetadata(preparedProbe),
    };
    entry.transcodeRequired = !preparedAssessment.compliant;
    extractImages(
      mediaPath,
      coverPath,
      keyframesDirectory,
      preparedProbe.durationSec,
      runCommand,
    );
    entries.push(entry);
  }

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries,
  };
  const manifestPath = path.join(directories.output, 'manifest.json');
  writeJsonAtomic(manifestPath, manifest);
  return manifest;
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--input', '--output'].includes(flag) || !value) {
      throw new Error('用法：preprocess.js --input <目录> --output <目录>');
    }
    values[flag] = value;
  }
  if (!values['--input'] || !values['--output']) {
    throw new Error('用法：preprocess.js --input <目录> --output <目录>');
  }
  return {
    inputDirectory: values['--input'],
    outputDirectory: values['--output'],
  };
}

if (require.main === module) {
  try {
    const manifest = preprocess(parseArguments(process.argv.slice(2)));
    process.stdout.write(`预处理完成：${manifest.entries.length} 条\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  parseArguments,
  preprocess,
};
