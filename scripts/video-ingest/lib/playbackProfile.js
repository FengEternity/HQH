const fs = require('node:fs');

const LIMITS = Object.freeze({
  maxWidth: 1280,
  maxFrameRate: 30,
  maxKeyframeGapSec: 2,
});

function assessPlaybackProfile(probe) {
  const reasons = [];
  if (probe.videoCodec !== 'h264') reasons.push('VIDEO_CODEC');
  if (!['main', 'baseline', 'constrained baseline'].includes(String(probe.profile).toLowerCase())) {
    reasons.push('VIDEO_PROFILE');
  }
  if (probe.pixelFormat !== 'yuv420p') reasons.push('PIXEL_FORMAT');
  if (!Number.isInteger(probe.width) || probe.width > LIMITS.maxWidth) reasons.push('VIDEO_WIDTH');
  if (!Number.isInteger(probe.height) || probe.height % 2 !== 0) reasons.push('VIDEO_HEIGHT');
  if (!Number.isFinite(probe.frameRate) || probe.frameRate > LIMITS.maxFrameRate) {
    reasons.push('FRAME_RATE');
  }
  if (probe.hasBFrames) reasons.push('B_FRAMES');
  if (
    !Number.isFinite(probe.maxKeyframeGapSec) ||
    probe.maxKeyframeGapSec > LIMITS.maxKeyframeGapSec
  ) {
    reasons.push('KEYFRAME_GAP');
  }
  if (probe.fastStart !== true) reasons.push('FASTSTART');
  if (probe.hasAudio && probe.audioCodec !== 'aac') reasons.push('AUDIO_CODEC');
  return { compliant: reasons.length === 0, reasons };
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

function parseFrameRate(value) {
  const [numeratorText, denominatorText] = String(value || '').split('/');
  const numerator = Number(numeratorText);
  const denominator = denominatorText === undefined ? 1 : Number(denominatorText);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return Number.NaN;
  }
  return numerator / denominator;
}

function parseKeyframeTimes(stdout) {
  const times = [];
  for (const line of Buffer.from(stdout || '').toString('utf8').split(/\r?\n/)) {
    const fields = line.split(',').map((field) => field.trim());
    if (!fields.some((field) => field.includes('K'))) continue;
    const time = fields.map(Number).find(Number.isFinite);
    if (time !== undefined) times.push(time);
  }
  return times.sort((left, right) => left - right);
}

function calculateMaxKeyframeGap(keyframeTimes, durationSec) {
  if (keyframeTimes.length === 0) return Number.NaN;
  if (keyframeTimes.length === 1) {
    return Math.max(0, durationSec - keyframeTimes[0]);
  }

  let maximum = 0;
  for (let index = 1; index < keyframeTimes.length; index += 1) {
    maximum = Math.max(maximum, keyframeTimes[index] - keyframeTimes[index - 1]);
  }
  return maximum;
}

function readTopLevelBoxPositions(filePath) {
  const fileSize = fs.statSync(filePath).size;
  const descriptor = fs.openSync(filePath, 'r');
  const positions = { moov: null, mdat: null };
  let offset = 0;

  try {
    while (offset + 8 <= fileSize) {
      const header = Buffer.alloc(16);
      if (fs.readSync(descriptor, header, 0, 8, offset) !== 8) break;

      const size32 = header.readUInt32BE(0);
      const type = header.toString('ascii', 4, 8);
      let headerSize = 8;
      let boxSize;

      if (size32 === 1) {
        if (offset + 16 > fileSize || fs.readSync(descriptor, header, 8, 8, offset + 8) !== 8) {
          break;
        }
        headerSize = 16;
        const size64 = header.readBigUInt64BE(8);
        if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) break;
        boxSize = Number(size64);
      } else if (size32 === 0) {
        boxSize = fileSize - offset;
      } else {
        boxSize = size32;
      }

      if (boxSize < headerSize || offset + boxSize > fileSize) break;
      if ((type === 'moov' || type === 'mdat') && positions[type] === null) {
        positions[type] = offset;
      }
      if (size32 === 0) break;
      offset += boxSize;
    }
  } finally {
    fs.closeSync(descriptor);
  }

  return positions;
}

function detectFastStart(filePath) {
  const positions = readTopLevelBoxPositions(filePath);
  return (
    positions.moov !== null &&
    positions.mdat !== null &&
    positions.moov < positions.mdat
  );
}

function probePlaybackMedia(filePath, runCommand, options = {}) {
  const ffprobeCommand = options.ffprobeCommand || 'ffprobe';
  const streamResult = runCommand(ffprobeCommand, [
    '-v', 'error',
    '-show_entries',
    'format=duration:stream=codec_type,codec_name,profile,pix_fmt,width,height,avg_frame_rate,has_b_frames',
    '-of', 'json',
    filePath,
  ], { encoding: null, shell: false });
  assertCommandSuccess(streamResult, ffprobeCommand);

  const payload = JSON.parse(Buffer.from(streamResult.stdout || '').toString('utf8'));
  const video = payload.streams?.find((stream) => stream.codec_type === 'video');
  const audio = payload.streams?.find((stream) => stream.codec_type === 'audio');
  const durationSec = Number(payload.format?.duration);
  if (!video || !Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error('媒体播放信息不完整');
  }

  const packetResult = runCommand(ffprobeCommand, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_packets',
    '-show_entries', 'packet=pts_time,flags',
    '-of', 'csv=p=0',
    filePath,
  ], { encoding: null, shell: false });
  assertCommandSuccess(packetResult, ffprobeCommand);

  const keyframeTimes = parseKeyframeTimes(packetResult.stdout);
  return {
    durationSec,
    videoCodec: String(video.codec_name || '').toLowerCase(),
    profile: String(video.profile || ''),
    pixelFormat: String(video.pix_fmt || '').toLowerCase(),
    width: Number(video.width),
    height: Number(video.height),
    frameRate: parseFrameRate(video.avg_frame_rate),
    hasBFrames: Number(video.has_b_frames) > 0,
    maxKeyframeGapSec: calculateMaxKeyframeGap(keyframeTimes, durationSec),
    fastStart: detectFastStart(filePath),
    hasAudio: Boolean(audio),
    audioCodec: audio ? String(audio.codec_name || '').toLowerCase() : '',
  };
}

function buildPlaybackFfmpegArgs(inputPath, outputPath, probe) {
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputPath,
    '-vf', "scale='min(1280,iw)':-2",
    '-c:v', 'libx264',
    '-profile:v', 'main',
    '-pix_fmt', 'yuv420p',
    '-preset', 'medium',
    '-crf', '23',
    '-bf', '0',
    '-fpsmax', '30',
    '-force_key_frames', 'expr:gte(t,n_forced*2)',
    '-sc_threshold', '0',
    ...(probe.hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
    '-movflags', '+faststart',
    outputPath,
  ];
}

function toPlaybackMetadata(probe) {
  return {
    videoCodec: probe.videoCodec,
    profile: probe.profile,
    pixelFormat: probe.pixelFormat,
    width: probe.width,
    height: probe.height,
    frameRate: probe.frameRate,
    hasBFrames: probe.hasBFrames,
    maxKeyframeGapSec: probe.maxKeyframeGapSec,
    fastStart: probe.fastStart,
    hasAudio: probe.hasAudio,
    audioCodec: probe.audioCodec,
    compliant: assessPlaybackProfile(probe).compliant,
  };
}

module.exports = {
  LIMITS,
  assessPlaybackProfile,
  buildPlaybackFfmpegArgs,
  probePlaybackMedia,
  toPlaybackMetadata,
};
