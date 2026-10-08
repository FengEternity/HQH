const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { normalizePrepared } = require('./normalize-prepared');

function mp4Box(type, payload = '') {
  const body = Buffer.from(payload);
  const box = Buffer.alloc(8 + body.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 4, 'ascii');
  body.copy(box, 8);
  return box;
}

function writeMp4(filePath, payload = 'original') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    Buffer.concat([mp4Box('ftyp'), mp4Box('moov'), mp4Box('mdat', payload)]),
  );
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-normalize-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mediaPath = path.join(directory, 'media', 'abc.mp4');
  writeMp4(mediaPath);
  const manifestPath = path.join(directory, 'manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      entries: [{
        sourceKey: 'abc',
        durationSec: 1,
        media: { videoCodec: 'hevc', audioCodec: 'aac', hasAudio: true },
        prepared: { media: 'media/abc.mp4', mediaSha256: 'old' },
      }],
    }),
  );
  return { directory, manifestPath, mediaPath };
}

function probePayload(codec, duration = 8.04) {
  return {
    format: { duration: String(duration) },
    streams: [
      {
        codec_type: 'video',
        codec_name: codec,
        profile: 'Main',
        pix_fmt: 'yuv420p',
        width: 1280,
        height: 720,
        avg_frame_rate: '30/1',
        has_b_frames: 0,
      },
      { codec_type: 'audio', codec_name: 'aac' },
    ],
  };
}

function runner({ rejectSecondProbe = false } = {}) {
  return (command, args) => {
    const input = args.at(-1);
    if (command === 'ffmpeg') {
      writeMp4(input, 'normalized');
      return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    if (args.includes('-show_packets')) {
      return {
        status: 0,
        stdout: Buffer.from('0,K_\n2,K_\n4,K_\n6,K_\n8,K_'),
        stderr: Buffer.alloc(0),
      };
    }
    const normalized = input.endsWith('.normalizing.mp4');
    if (normalized && rejectSecondProbe) {
      return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('bad output') };
    }
    return {
      status: 0,
      stdout: Buffer.from(JSON.stringify(probePayload(normalized ? 'h264' : 'hevc'))),
      stderr: Buffer.alloc(0),
    };
  };
}

test('不合格文件复检合格后原子替换并原子更新 manifest', (t) => {
  const { manifestPath, mediaPath } = fixture(t);

  const result = normalizePrepared({ manifestPath, runCommand: runner() });

  assert.deepEqual(result, { compliant: 0, transcoded: 1, failed: 0 });
  assert.equal(fs.readFileSync(mediaPath).includes('normalized'), true);
  assert.equal(fs.existsSync(path.join(path.dirname(mediaPath), 'abc.normalizing.mp4')), false);
  assert.equal(fs.existsSync(`${manifestPath}.tmp`), false);
  const saved = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(saved.entries[0].durationSec, 8);
  assert.equal(saved.entries[0].transcodeRequired, true);
  assert.equal(saved.entries[0].media.videoCodec, 'h264');
  assert.equal(saved.entries[0].media.audioCodec, 'aac');
  assert.equal(saved.entries[0].media.hasAudio, true);
  assert.equal(saved.entries[0].media.playback.compliant, true);
  assert.equal(
    saved.entries[0].prepared.mediaSha256,
    crypto.createHash('sha256').update(fs.readFileSync(mediaPath)).digest('hex'),
  );
});

test('第二次探测失败时删除临时文件并保留原文件', (t) => {
  const { manifestPath, mediaPath } = fixture(t);
  const before = fs.readFileSync(mediaPath);

  const result = normalizePrepared({
    manifestPath,
    runCommand: runner({ rejectSecondProbe: true }),
  });

  assert.deepEqual(result, { compliant: 0, transcoded: 0, failed: 1 });
  assert.deepEqual(fs.readFileSync(mediaPath), before);
  assert.equal(fs.existsSync(path.join(path.dirname(mediaPath), 'abc.normalizing.mp4')), false);
});

test('已合格文件只更新播放元数据，不调用 ffmpeg', (t) => {
  const { manifestPath } = fixture(t);
  const calls = [];
  const runCommand = (command, args) => {
    calls.push(command);
    if (args.includes('-show_packets')) {
      return { status: 0, stdout: Buffer.from('0,K_\n2,K_\n4,K_\n6,K_\n8,K_'), stderr: Buffer.alloc(0) };
    }
    return {
      status: 0,
      stdout: Buffer.from(JSON.stringify(probePayload('h264'))),
      stderr: Buffer.alloc(0),
    };
  };

  const result = normalizePrepared({ manifestPath, runCommand });

  assert.deepEqual(result, { compliant: 1, transcoded: 0, failed: 0 });
  assert.equal(calls.includes('ffmpeg'), false);
  const saved = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(saved.entries[0].media.playback.compliant, true);
});

test('拒绝 manifest 目录外路径与逃逸软链', (t) => {
  const { directory, manifestPath } = fixture(t);
  const outside = path.join(os.tmpdir(), `hqh-outside-${process.pid}.mp4`);
  writeMp4(outside);
  t.after(() => fs.rmSync(outside, { force: true }));
  fs.symlinkSync(outside, path.join(directory, 'media', 'escape.mp4'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.entries = [
    { sourceKey: 'outside', prepared: { media: '../outside.mp4' } },
    { sourceKey: 'escape', prepared: { media: 'media/escape.mp4' } },
  ];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  let probes = 0;

  const result = normalizePrepared({
    manifestPath,
    runCommand: () => {
      probes += 1;
      throw new Error('不应探测');
    },
  });

  assert.deepEqual(result, { compliant: 0, transcoded: 0, failed: 2 });
  assert.equal(probes, 0);
});
