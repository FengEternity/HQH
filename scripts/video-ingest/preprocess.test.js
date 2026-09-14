const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { preprocess } = require('./preprocess');

function createFakeRunner() {
  return (command, args, options = {}) => {
    assert.equal(typeof command, 'string');
    assert.equal(Array.isArray(args), true);
    assert.notEqual(options.shell, true);

    if (args.includes('-version')) {
      return { status: 0, stdout: Buffer.from('available'), stderr: Buffer.alloc(0) };
    }

    if (command === 'ffprobe') {
      const input = args.at(-1);
      const isHevc = input.includes('南方数据导出');
      return {
        status: 0,
        stdout: Buffer.from(
          JSON.stringify({
            format: { duration: isHevc ? '16.04' : '8.01' },
            streams: [
              { codec_type: 'video', codec_name: isHevc ? 'hevc' : 'h264' },
              { codec_type: 'audio', codec_name: 'aac' },
            ],
          }),
        ),
        stderr: Buffer.alloc(0),
      };
    }

    assert.equal(command, 'ffmpeg');
    const output = args.at(-1).replace('%04d', '0001');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, 'generated');
    return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
}

test('预处理使用数组命令并生成转码媒体、封面、关键帧与相对路径清单', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-video-ingest-'));
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  fs.mkdirSync(path.join(input, '中海达'), { recursive: true });
  fs.mkdirSync(path.join(input, '南方'), { recursive: true });
  fs.writeFileSync(path.join(input, '中海达', '中海达点测量.mp4'), 'h264-source');
  fs.writeFileSync(path.join(input, '南方', '南方数据导出.mp4'), 'hevc-source');

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
    fs.readFileSync(path.join(input, '南方', '南方数据导出.mp4'), 'utf8'),
    'hevc-source',
  );
});
