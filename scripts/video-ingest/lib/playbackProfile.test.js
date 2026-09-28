const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  assessPlaybackProfile,
  buildPlaybackFfmpegArgs,
  probePlaybackMedia,
  toPlaybackMetadata,
} = require('./playbackProfile');

const compliantProbe = {
  durationSec: 60,
  videoCodec: 'h264',
  profile: 'Main',
  pixelFormat: 'yuv420p',
  width: 1280,
  height: 720,
  frameRate: 30,
  hasBFrames: false,
  maxKeyframeGapSec: 2,
  fastStart: true,
  hasAudio: true,
  audioCodec: 'aac',
};

function makeBox(type, payload = Buffer.alloc(0), use64BitSize = false) {
  const headerSize = use64BitSize ? 16 : 8;
  const box = Buffer.alloc(headerSize + payload.length);
  box.writeUInt32BE(use64BitSize ? 1 : box.length, 0);
  box.write(type, 4, 4, 'ascii');
  if (use64BitSize) box.writeBigUInt64BE(BigInt(box.length), 8);
  payload.copy(box, headerSize);
  return box;
}

function createMp4Fixture(boxes) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-playback-profile-'));
  const filePath = path.join(directory, 'fixture.mp4');
  fs.writeFileSync(filePath, Buffer.concat(boxes));
  return filePath;
}

function createProbeRunner() {
  const calls = [];
  const runCommand = (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(command, 'ffprobe');
    assert.notEqual(options.shell, true);

    if (args.includes('-show_packets')) {
      return {
        status: 0,
        stdout: Buffer.from('0.000000,K_\n1.500000,K_\n3.000000,K_\n'),
        stderr: Buffer.alloc(0),
      };
    }

    return {
      status: 0,
      stdout: Buffer.from(JSON.stringify({
        format: { duration: '4.2' },
        streams: [
          {
            codec_type: 'video',
            codec_name: 'h264',
            profile: 'Main',
            pix_fmt: 'yuv420p',
            width: 1280,
            height: 720,
            avg_frame_rate: '30000/1001',
            has_b_frames: 0,
          },
          { codec_type: 'audio', codec_name: 'aac' },
        ],
      })),
      stderr: Buffer.alloc(0),
    };
  };
  return { calls, runCommand };
}

test('合规播放规格通过检查', () => {
  assert.deepEqual(assessPlaybackProfile(compliantProbe), {
    compliant: true,
    reasons: [],
  });
});

test('每项不合规播放规格均返回稳定原因码', () => {
  const cases = [
    ['videoCodec', 'hevc', 'VIDEO_CODEC'],
    ['profile', 'High', 'VIDEO_PROFILE'],
    ['pixelFormat', 'yuv444p', 'PIXEL_FORMAT'],
    ['width', 1920, 'VIDEO_WIDTH'],
    ['frameRate', 60, 'FRAME_RATE'],
    ['hasBFrames', true, 'B_FRAMES'],
    ['maxKeyframeGapSec', 10, 'KEYFRAME_GAP'],
    ['fastStart', false, 'FASTSTART'],
    ['audioCodec', 'opus', 'AUDIO_CODEC'],
  ];

  for (const [field, value, reason] of cases) {
    const result = assessPlaybackProfile({ ...compliantProbe, [field]: value });
    assert.equal(result.compliant, false, field);
    assert.equal(result.reasons.includes(reason), true, field);
  }
});

test('关键帧间隔严格大于两秒即不合规', () => {
  const result = assessPlaybackProfile({
    ...compliantProbe,
    maxKeyframeGapSec: 2.0001,
  });
  assert.equal(result.compliant, false);
  assert.equal(result.reasons.includes('KEYFRAME_GAP'), true);
});

test('探测解析帧率、关键帧间隔和 32 位 MP4 faststart', () => {
  const filePath = createMp4Fixture([
    makeBox('ftyp'),
    makeBox('moov'),
    makeBox('mdat'),
  ]);
  const { calls, runCommand } = createProbeRunner();

  const probe = probePlaybackMedia(filePath, runCommand);

  assert.equal(calls.length, 2);
  assert.equal(Math.abs(probe.frameRate - 29.97002997) < 1e-7, true);
  assert.equal(probe.maxKeyframeGapSec, 1.5);
  assert.equal(probe.fastStart, true);
  assert.equal(probe.hasBFrames, false);
  assert.equal(probe.hasAudio, true);
  assert.equal(probe.audioCodec, 'aac');
});

test('MP4 顶层 64 位 box 中 moov 必须位于 mdat 前', () => {
  const filePath = createMp4Fixture([
    makeBox('ftyp', Buffer.alloc(0), true),
    makeBox('mdat', Buffer.alloc(0), true),
    makeBox('moov', Buffer.alloc(0), true),
  ]);
  const { runCommand } = createProbeRunner();

  assert.equal(probePlaybackMedia(filePath, runCommand).fastStart, false);
});

test('单关键帧短片用末段计算最大关键帧间隔', () => {
  const filePath = createMp4Fixture([makeBox('moov'), makeBox('mdat')]);
  const base = createProbeRunner();
  const runCommand = (command, args, options) => {
    if (args.includes('-show_packets')) {
      return {
        status: 0,
        stdout: Buffer.from('0.250000,K_\n'),
        stderr: Buffer.alloc(0),
      };
    }
    return base.runCommand(command, args, options);
  };

  assert.equal(probePlaybackMedia(filePath, runCommand).maxKeyframeGapSec, 3.95);
});

test('转码参数固定视频规格并按音轨选择 AAC 或静音', () => {
  const videoArgs = buildPlaybackFfmpegArgs('input.mp4', 'output.mp4', compliantProbe);
  assert.deepEqual(videoArgs, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-i', 'input.mp4',
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
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    'output.mp4',
  ]);

  const silentArgs = buildPlaybackFfmpegArgs(
    'input.mp4',
    'output.mp4',
    { ...compliantProbe, hasAudio: false, audioCodec: '' },
  );
  assert.equal(silentArgs.includes('-an'), true);
  assert.equal(silentArgs.includes('-c:a'), false);
});

test('播放元数据包含规格判断结果', () => {
  assert.deepEqual(toPlaybackMetadata(compliantProbe), {
    videoCodec: 'h264',
    profile: 'Main',
    pixelFormat: 'yuv420p',
    width: 1280,
    height: 720,
    frameRate: 30,
    hasBFrames: false,
    maxKeyframeGapSec: 2,
    fastStart: true,
    hasAudio: true,
    audioCodec: 'aac',
    compliant: true,
  });
});
