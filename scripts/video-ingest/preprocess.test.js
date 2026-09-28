const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { preprocess } = require('./preprocess');

function mp4Box(type, payload = '') {
  const body = Buffer.from(payload);
  const box = Buffer.alloc(8 + body.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 4, 'ascii');
  body.copy(box, 8);
  return box;
}

function writeFastStartMp4(filePath, payload = 'video') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    Buffer.concat([mp4Box('ftyp'), mp4Box('moov'), mp4Box('mdat', payload)]),
  );
}

function createFakeRunner({
  durationSec,
  sourceKeyframeTimes,
  transcodedKeyframeTimes,
  rejectExistingTranscodeOutput = false,
  successfulCoverSeeks,
  writeKeyframes = true,
  calls = [],
} = {}) {
  const transcodedOutputs = new Set();
  return (command, args, options = {}) => {
    calls.push({ command, args: [...args] });
    assert.equal(typeof command, 'string');
    assert.equal(Array.isArray(args), true);
    assert.notEqual(options.shell, true);

    if (args.includes('-version')) {
      return { status: 0, stdout: Buffer.from('available'), stderr: Buffer.alloc(0) };
    }

    if (command === 'ffprobe') {
      const input = args.at(-1);
      const isPacketProbe = args.includes('-show_packets');
      const isTranscoded = transcodedOutputs.has(input);
      if (isPacketProbe) {
        const keyframeTimes =
          isTranscoded && transcodedKeyframeTimes
            ? transcodedKeyframeTimes
            : !isTranscoded && sourceKeyframeTimes
              ? sourceKeyframeTimes
              : [0, 2, 4, 6, 8];
        return {
          status: 0,
          stdout: Buffer.from(
            keyframeTimes.map((time) => `${time},K_`).join('\n'),
          ),
          stderr: Buffer.alloc(0),
        };
      }
      const isHevc = !isTranscoded && input.includes('南方数据导出');
      return {
        status: 0,
        stdout: Buffer.from(
          JSON.stringify({
            format: { duration: String(durationSec ?? (isHevc ? 16.04 : 8.01)) },
            streams: [
              {
                codec_type: 'video',
                codec_name: isHevc ? 'hevc' : 'h264',
                profile: 'Main',
                pix_fmt: 'yuv420p',
                width: 1280,
                height: 720,
                avg_frame_rate: '30/1',
                has_b_frames: 0,
              },
              { codec_type: 'audio', codec_name: 'aac' },
            ],
          }),
        ),
        stderr: Buffer.alloc(0),
      };
    }

    assert.equal(command, 'ffmpeg');
    const outputArgument = args.at(-1);
    const isTranscode = args.includes('libx264');
    if (
      isTranscode &&
      rejectExistingTranscodeOutput &&
      fs.existsSync(outputArgument)
    ) {
      return {
        status: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from('refusing to replace stale media'),
      };
    }
    const isKeyframeExtraction = args.includes('fps=1/8');
    if (isTranscode) {
      transcodedOutputs.add(outputArgument);
    }
    const seekIndex = args.indexOf('-ss');
    const seek = seekIndex >= 0 ? args[seekIndex + 1] : null;
    const shouldWrite =
      (isKeyframeExtraction && writeKeyframes) ||
      (!isKeyframeExtraction &&
        (seek === null ||
          successfulCoverSeeks === undefined ||
          successfulCoverSeeks.includes(seek)));
    if (shouldWrite) {
      const output = args.at(-1).replace('%04d', '0001');
      if (isTranscode) {
        writeFastStartMp4(output, 'transcoded');
      } else {
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, 'generated');
      }
    }
    return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
}

function createSingleVideoFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-video-ingest-'));
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  fs.mkdirSync(path.join(input, '中海达'), { recursive: true });
  writeFastStartMp4(
    path.join(input, '中海达', '中海达点测量.mp4'),
    'h264-source',
  );
  return { input, output };
}

test('预处理使用数组命令并生成转码媒体、封面、关键帧与相对路径清单', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-video-ingest-'));
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  fs.mkdirSync(path.join(input, '中海达'), { recursive: true });
  fs.mkdirSync(path.join(input, '南方'), { recursive: true });
  writeFastStartMp4(path.join(input, '中海达', '中海达点测量.mp4'), 'h264-source');
  writeFastStartMp4(path.join(input, '南方', '南方数据导出.mp4'), 'hevc-source');

  const manifest = preprocess({
    inputDirectory: input,
    outputDirectory: output,
    runCommand: createFakeRunner(),
  });

  assert.equal(manifest.entries.length, 2);
  assert.equal(manifest.entries.every((entry) => !JSON.stringify(entry).includes(root)), true);
  for (const entry of manifest.entries) {
    assert.equal(fs.existsSync(path.join(output, entry.prepared.media)), true);
    assert.equal(fs.existsSync(path.join(output, entry.prepared.cover)), true);
    assert.equal(fs.existsSync(path.join(output, entry.prepared.keyframes, '0001.jpg')), true);
  }
  assert.equal(fs.existsSync(path.join(output, 'manifest.json')), true);
  assert.equal(
    fs.readFileSync(path.join(input, '南方', '南方数据导出.mp4')).includes('hevc-source'),
    true,
  );
});

test('H.264 + AAC 但关键帧间隔 10 秒时按统一规格转码', () => {
  const { input, output } = createSingleVideoFixture();
  const calls = [];

  const manifest = preprocess({
    inputDirectory: input,
    outputDirectory: output,
    runCommand: createFakeRunner({
      durationSec: 20,
      sourceKeyframeTimes: [0, 10, 20],
      calls,
    }),
  });

  const entry = manifest.entries[0];
  const transcodeArgs = calls.find(
    ({ command, args }) => command === 'ffmpeg' && args.includes('libx264'),
  ).args;
  assert.equal(entry.transcodeRequired, false);
  assert.equal(entry.media.playback.maxKeyframeGapSec, 2);
  assert.equal(transcodeArgs.includes('-bf'), true);
  assert.equal(transcodeArgs.includes('+faststart'), true);
});

test('完全符合播放规格且关键帧间隔 2 秒时直接复制', () => {
  const { input, output } = createSingleVideoFixture();
  const calls = [];

  const manifest = preprocess({
    inputDirectory: input,
    outputDirectory: output,
    runCommand: createFakeRunner({ sourceKeyframeTimes: [0, 2, 4, 6, 8], calls }),
  });

  assert.equal(manifest.entries[0].transcodeRequired, false);
  assert.equal(
    calls.some(({ command, args }) => command === 'ffmpeg' && args.includes('libx264')),
    false,
  );
});

test('转码产物二次检查不合格时不写 manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-video-ingest-'));
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  fs.mkdirSync(path.join(input, '南方'), { recursive: true });
  writeFastStartMp4(path.join(input, '南方', '南方数据导出.mp4'), 'hevc-source');

  assert.throws(
    () =>
      preprocess({
        inputDirectory: input,
        outputDirectory: output,
        runCommand: createFakeRunner({ transcodedKeyframeTimes: [0, 10] }),
      }),
    /转码产物不符合播放规格：KEYFRAME_GAP/,
  );
  assert.equal(fs.existsSync(path.join(output, 'manifest.json')), false);
});

test('copy 与 transcode 路径可在同一 output 连续运行两次', () => {
  const scenarios = [
    {
      brand: '中海达',
      title: '中海达点测量',
      runner: createFakeRunner(),
      sourceMode: 0o444,
    },
    {
      brand: '南方',
      title: '南方数据导出',
      runner: createFakeRunner({ rejectExistingTranscodeOutput: true }),
      sourceMode: 0o644,
    },
  ];
  const outcomes = [];

  for (const scenario of scenarios) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-video-ingest-'));
    const input = path.join(root, 'input');
    const output = path.join(root, 'output');
    const source = path.join(
      input,
      scenario.brand,
      `${scenario.title}.mp4`,
    );
    fs.mkdirSync(path.dirname(source), { recursive: true });
    writeFastStartMp4(source, 'source');
    fs.chmodSync(source, scenario.sourceMode);
    const sourceModeBefore = fs.statSync(source).mode & 0o777;

    try {
      const first = preprocess({
        inputDirectory: input,
        outputDirectory: output,
        runCommand: scenario.runner,
      });
      const second = preprocess({
        inputDirectory: input,
        outputDirectory: output,
        runCommand: scenario.runner,
      });
      const mediaFiles = fs
        .readdirSync(path.join(output, 'media'))
        .filter((fileName) => fileName.endsWith('.mp4'));
      const preparedMedia = path.join(
        output,
        second.entries[0].prepared.media,
      );
      outcomes.push({
        firstEntries: first.entries.length,
        secondEntries: second.entries.length,
        mediaFiles: mediaFiles.length,
        preparedWritable: Boolean(fs.statSync(preparedMedia).mode & 0o200),
        sourceModeUnchanged:
          (fs.statSync(source).mode & 0o777) === sourceModeBefore,
      });
    } catch (error) {
      outcomes.push({ error: error.message });
    }
  }

  assert.deepEqual(outcomes, [
    {
      firstEntries: 1,
      secondEntries: 1,
      mediaFiles: 1,
      preparedWritable: true,
      sourceModeUnchanged: true,
    },
    {
      firstEntries: 1,
      secondEntries: 1,
      mediaFiles: 1,
      preparedWritable: true,
      sourceModeUnchanged: true,
    },
  ]);
});

test('写出的 manifest 只对属主可读写', () => {
  const { input, output } = createSingleVideoFixture();

  preprocess({
    inputDirectory: input,
    outputDirectory: output,
    runCommand: createFakeRunner(),
  });

  const manifestPath = path.join(output, 'manifest.json');
  assert.equal(fs.statSync(manifestPath).mode & 0o777, 0o600);
});

test('拒绝输出目录位于输入目录内', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-video-ingest-'));
  const input = path.join(root, 'input');
  fs.mkdirSync(input);

  assert.throws(
    () =>
      preprocess({
        inputDirectory: input,
        outputDirectory: path.join(input, 'prepared'),
        runCommand: createFakeRunner(),
      }),
    /目录/,
  );
});

test('拒绝输入目录位于输出目录内', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-video-ingest-'));
  const input = path.join(root, 'input');
  fs.mkdirSync(input);

  assert.throws(
    () =>
      preprocess({
        inputDirectory: input,
        outputDirectory: root,
        runCommand: createFakeRunner(),
      }),
    /目录/,
  );
});

test('拒绝已存在的输出软链指向输入目录', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-video-ingest-'));
  const input = path.join(root, 'input');
  const outputLink = path.join(root, 'output-link');
  fs.mkdirSync(input);
  fs.symlinkSync(input, outputLink, 'dir');

  assert.throws(
    () =>
      preprocess({
        inputDirectory: input,
        outputDirectory: outputLink,
        runCommand: createFakeRunner(),
      }),
    /目录/,
  );
  assert.equal(fs.existsSync(path.join(input, 'manifest.json')), false);
});

test('第 1 秒无封面时回退第 3 秒', () => {
  const { input, output } = createSingleVideoFixture();

  const manifest = preprocess({
    inputDirectory: input,
    outputDirectory: output,
    runCommand: createFakeRunner({
      durationSec: 8,
      successfulCoverSeeks: ['3'],
    }),
  });

  assert.equal(
    fs.existsSync(path.join(output, manifest.entries[0].prepared.cover)),
    true,
  );
});

test('不足 3 秒的短片用时长中点回退封面', () => {
  const { input, output } = createSingleVideoFixture();

  const manifest = preprocess({
    inputDirectory: input,
    outputDirectory: output,
    runCommand: createFakeRunner({
      durationSec: 1.2,
      successfulCoverSeeks: ['0.6'],
    }),
  });

  assert.equal(
    fs.existsSync(path.join(output, manifest.entries[0].prepared.cover)),
    true,
  );
});

test('两次封面抽取都无文件时明确报错', () => {
  const { input, output } = createSingleVideoFixture();

  assert.throws(
    () =>
      preprocess({
        inputDirectory: input,
        outputDirectory: output,
        runCommand: createFakeRunner({
          durationSec: 8,
          successfulCoverSeeks: [],
        }),
      }),
    /封面提取失败/,
  );
});

test('关键帧抽取后没有图片时明确报错', () => {
  const { input, output } = createSingleVideoFixture();

  assert.throws(
    () =>
      preprocess({
        inputDirectory: input,
        outputDirectory: output,
        runCommand: createFakeRunner({ writeKeyframes: false }),
      }),
    /关键帧提取失败/,
  );
});
