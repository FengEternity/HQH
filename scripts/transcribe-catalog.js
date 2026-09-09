'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CATALOG_PATH = path.join(ROOT, 'miniprogram/data/catalog.js');
const VIDEO_DIR = path.join(ROOT, '视频');
const WORK_DIR = path.join(ROOT, 'miniprogram/data/asr-work');
const GLOSSARY_PATH = path.join(ROOT, 'miniprogram/data/asr-glossary.txt');

const FORCE = process.argv.includes('--force');
const PUBLISHED_ONLY = process.argv.includes('--published-only');
const MODEL = process.env.WHISPER_MODEL || 'small';
const DEVICE = process.env.WHISPER_DEVICE || 'cpu';

function loadCatalog() {
  delete require.cache[require.resolve(CATALOG_PATH)];
  return require(CATALOG_PATH);
}

function saveCatalog(db) {
  fs.writeFileSync(CATALOG_PATH, 'module.exports = ' + JSON.stringify(db, null, 2) + ';\n');
}

function extractAudio(src, wavPath) {
  const result = spawnSync(
    'ffmpeg',
    ['-y', '-i', src, '-vn', '-ac', '1', '-ar', '16000', wavPath],
    { stdio: 'ignore' },
  );
  if (result.status !== 0 || !fs.existsSync(wavPath)) {
    throw new Error('抽音频失败');
  }
}

function transcribeWav(wavPath, outDir, prompt) {
  const args = [
    wavPath,
    '--language',
    'zh',
    '--model',
    MODEL,
    '--device',
    DEVICE,
    '--output_dir',
    outDir,
    '--output_format',
    'json',
    '--verbose',
    'False',
  ];
  if (prompt) {
    args.push('--initial_prompt', prompt);
  }
  const result = spawnSync('whisper', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'whisper 失败').slice(0, 400));
  }
  const jsonPath = path.join(outDir, path.basename(wavPath, path.extname(wavPath)) + '.json');
  if (!fs.existsSync(jsonPath)) {
    throw new Error('未找到 whisper json：' + jsonPath);
  }
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}

function toSegments(raw) {
  const list = Array.isArray(raw.segments) ? raw.segments : [];
  return list
    .map((item) => ({
      startSec: Math.round(Number(item.start || 0) * 10) / 10,
      endSec: Math.round(Number(item.end || 0) * 10) / 10,
      text: String(item.text || '').trim(),
    }))
    .filter((item) => item.text);
}

function main() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const glossary = fs.existsSync(GLOSSARY_PATH) ? fs.readFileSync(GLOSSARY_PATH, 'utf8').trim() : '';
  const db = loadCatalog();
  const jobs = (db.videos || []).filter((video) => {
    if (!video.localFile) {
      return false;
    }
    if (PUBLISHED_ONLY && video.status !== 'published') {
      return false;
    }
    if (!FORCE && String(video.transcript || '').trim()) {
      return false;
    }
    return true;
  });
  process.stdout.write(
    'whisper model=' + MODEL + ' device=' + DEVICE + ' jobs=' + jobs.length + '\n',
  );
  jobs.forEach((video, index) => {
    const src = path.join(VIDEO_DIR, path.basename(video.localFile));
    process.stdout.write('[' + (index + 1) + '/' + jobs.length + '] ' + video._id + ' ' + video.localFile + '\n');
    if (!fs.existsSync(src)) {
      process.stderr.write('  skip missing file\n');
      return;
    }
    const wavPath = path.join(WORK_DIR, video._id + '.wav');
    extractAudio(src, wavPath);
    const raw = transcribeWav(wavPath, WORK_DIR, glossary);
    const segments = toSegments(raw);
    video.transcript = String(raw.text || '')
      .replace(/\s+/g, ' ')
      .trim();
    video.transcriptSegments = segments;
    video.updatedAt = Date.now();
    saveCatalog(db);
    process.stdout.write('  chars=' + video.transcript.length + ' segs=' + segments.length + '\n');
  });
}

main();
