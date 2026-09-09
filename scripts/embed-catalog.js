'use strict';

const fs = require('fs');
const path = require('path');
const { getAiEnv, embedTexts } = require('./openaiCompat');
const { videoIndexText } = require('../cloudfunctions/catalog/lib/aiSearch');

const ROOT = path.join(__dirname, '..');
const CATALOG_PATH = path.join(ROOT, 'miniprogram/data/catalog.js');
const INDEX_PATH = path.join(ROOT, 'miniprogram/data/ai-index.json');
const BATCH = 16;

function loadCatalog() {
  delete require.cache[require.resolve(CATALOG_PATH)];
  return require(CATALOG_PATH);
}

async function embedBatch(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const chunk = texts.slice(i, i + BATCH);
    const vectors = await embedTexts(chunk, 60000);
    out.push.apply(out, vectors);
    process.stdout.write('embedded ' + out.length + '/' + texts.length + '\n');
  }
  return out;
}

async function main() {
  const env = getAiEnv();
  if (!env.apiKey) {
    process.stderr.write('NO_API_KEY：请设置 OPENAI_API_KEY（及 OPENAI_BASE_URL）\n');
    process.exit(1);
  }
  if (!env.baseUrl) {
    process.stderr.write('NO_API_BASE：请设置 OPENAI_BASE_URL，例如 https://api.openai.com\n');
    process.exit(1);
  }
  const db = loadCatalog();
  const published = (db.videos || []).filter((item) => {
    if (item.status !== 'published') {
      return false;
    }
    return String(item.searchAbstract || '').trim() || String(item.transcript || '').trim();
  });
  const videoDocs = published.map((video) => ({
    _id: video._id,
    text: videoIndexText(video),
  }));
  const segmentDocs = [];
  published.forEach((video) => {
    (video.transcriptSegments || []).forEach((seg) => {
      const text = String((seg && seg.text) || '').trim();
      if (!text) {
        return;
      }
      const startSec = Number(seg.startSec) || 0;
      segmentDocs.push({
        _id: video._id + ':' + startSec,
        videoId: video._id,
        startSec,
        endSec: Number(seg.endSec) || startSec,
        text,
      });
    });
  });
  const videoVecs = await embedBatch(videoDocs.map((item) => item.text));
  const segVecs = await embedBatch(segmentDocs.map((item) => item.text));
  const index = {
    model: env.embedModel,
    updatedAt: Date.now(),
    videos: videoDocs.map((item, i) => Object.assign({}, item, { vector: videoVecs[i] })),
    segments: segmentDocs.map((item, i) => Object.assign({}, item, { vector: segVecs[i] })),
  };
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index));
  process.stdout.write(
    'wrote ' + INDEX_PATH + ' videos=' + index.videos.length + ' segments=' + index.segments.length + '\n',
  );
}

main().catch((error) => {
  process.stderr.write((error && error.message) || String(error) + '\n');
  process.exit(1);
});
