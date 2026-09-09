'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildSearchBlob, searchPublished } = require('../cloudfunctions/catalog/lib/catalogSearch');
const { runAiSearch } = require('../cloudfunctions/catalog/lib/aiSearch');
const { chatJson, embedTexts } = require('./openaiCompat');

const PORT = Number(process.env.PORT) || 8787;
const CATALOG_PATH = path.join(__dirname, '../miniprogram/data/catalog.js');
const AI_INDEX_PATH = path.join(__dirname, '../miniprogram/data/ai-index.json');
const VIDEO_DIR = path.resolve(__dirname, '../视频');
const POSTER_DIR = path.join(__dirname, '../miniprogram/data/posters');

function hydrate(raw) {
  return {
    brands: (raw.brands || []).slice(),
    products: (raw.products || []).slice(),
    videos: (raw.videos || []).map((item) => {
      const video = Object.assign({}, item);
      video.searchBlob = buildSearchBlob(video);
      return video;
    }),
    synonyms: (raw.synonyms || []).slice(),
  };
}

function loadCatalog() {
  delete require.cache[require.resolve(CATALOG_PATH)];
  return hydrate(require(CATALOG_PATH));
}

function persistCatalog() {
  const out = {
    brands: db.brands,
    products: db.products || [],
    videos: db.videos.map((item) => {
      const copy = Object.assign({}, item);
      delete copy.searchBlob;
      delete copy.posterUrl;
      return copy;
    }),
    synonyms: db.synonyms,
  };
  fs.writeFileSync(CATALOG_PATH, 'module.exports = ' + JSON.stringify(out, null, 2) + ';\n');
}

// 同一毫秒连点两次不能撞 id
function newId(prefix) {
  return prefix + Date.now() + Math.random().toString(16).slice(2, 6);
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mov') {
    return 'video/quicktime';
  }
  return 'video/mp4';
}

function serveLocalVideo(req, res, fileName) {
  const safeName = path.basename(fileName);
  const filePath = path.join(VIDEO_DIR, safeName);
  if (!filePath.startsWith(VIDEO_DIR + path.sep) || !fs.existsSync(filePath)) {
    json(res, 404, { ok: false, message: 'video not found' });
    return;
  }
  const stat = fs.statSync(filePath);
  const mime = mimeFor(filePath);
  const range = req.headers.range;
  const headers = {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
  };
  if (!range) {
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.writeHead(416);
    res.end();
    return;
  }
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : stat.size - 1;
  if (start >= stat.size || end >= stat.size || start > end) {
    res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size });
    res.end();
    return;
  }
  res.writeHead(206, {
    'Content-Type': mime,
    'Content-Length': end - start + 1,
    'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

function posterFile(id) {
  const safe = path.basename(String(id || ''));
  if (!/^[a-zA-Z0-9_-]+$/.test(safe)) {
    return '';
  }
  return path.join(POSTER_DIR, safe + '.jpg');
}

function ensurePosters() {
  fs.mkdirSync(POSTER_DIR, { recursive: true });
  db.videos.forEach((video) => {
    if (!video.localFile) {
      video.posterUrl = '';
      return;
    }
    const out = posterFile(video._id);
    const src = path.join(VIDEO_DIR, path.basename(video.localFile));
    if (!out || !fs.existsSync(src)) {
      video.posterUrl = '';
      return;
    }
    if (!fs.existsSync(out) || fs.statSync(out).size < 100) {
      spawnSync(
        'ffmpeg',
        ['-y', '-ss', '1', '-i', src, '-frames:v', '1', '-vf', 'scale=720:-2', '-q:v', '4', out],
        { stdio: 'ignore' },
      );
    }
    video.posterUrl =
      fs.existsSync(out) && fs.statSync(out).size > 100
        ? '/poster/' + video._id + '.jpg?t=' + (video.updatedAt || Date.now())
        : '';
  });
}

function setCustomCover(video) {
  video.coverCustom = true;
  video.updatedAt = Date.now();
  video.posterUrl = '/poster/' + video._id + '.jpg?t=' + video.updatedAt;
  persistCatalog();
}

function extractCoverFrame(video, timeSec) {
  const src = path.join(VIDEO_DIR, path.basename(video.localFile || ''));
  const out = posterFile(video._id);
  if (!out || !fs.existsSync(src)) {
    throw new Error('没有可截帧的本地视频');
  }
  fs.mkdirSync(POSTER_DIR, { recursive: true });
  const t = Math.max(0, Number(timeSec) || 0);
  const result = spawnSync(
    'ffmpeg',
    ['-y', '-ss', String(t), '-i', src, '-frames:v', '1', '-vf', 'scale=720:-2', '-q:v', '3', out],
    { stdio: 'ignore' },
  );
  if (result.status !== 0 || !fs.existsSync(out) || fs.statSync(out).size < 100) {
    throw new Error('截帧失败');
  }
  setCustomCover(video);
}

function writeCoverImage(video, image) {
  const out = posterFile(video._id);
  if (!out) {
    throw new Error('缺少视频 id');
  }
  const raw = Buffer.from(String(image || '').replace(/^data:image\/[a-zA-Z0-9+]+;base64,/, ''), 'base64');
  if (raw.length < 80 || raw.length > 8 * 1024 * 1024) {
    throw new Error('图片太大或无效');
  }
  fs.mkdirSync(POSTER_DIR, { recursive: true });
  const tmp = path.join(POSTER_DIR, video._id + '-upload.bin');
  fs.writeFileSync(tmp, raw);
  const result = spawnSync(
    'ffmpeg',
    ['-y', '-i', tmp, '-frames:v', '1', '-vf', 'scale=720:-2', '-q:v', '3', out],
    { stdio: 'ignore' },
  );
  try {
    fs.unlinkSync(tmp);
  } catch (error) {
    /* ignore */
  }
  if (result.status !== 0 || !fs.existsSync(out) || fs.statSync(out).size < 100) {
    throw new Error('封面图处理失败');
  }
  setCustomCover(video);
}

function servePoster(req, res, id) {
  const filePath = posterFile(id);
  if (!filePath || !fs.existsSync(filePath)) {
    json(res, 404, { ok: false, message: 'poster not found' });
    return;
  }
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

let db = loadCatalog();
ensurePosters();


function json(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}


const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/') {
    json(res, 200, {
      ok: true,
      service: 'hqh-local-media',
      hint: '浏览器页面已移除，请用微信开发者工具打开小程序；本服务只提供 /media /poster 与运营 API。',
    });
    return;
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.indexOf('/poster/') === 0) {
    servePoster(req, res, decodeURIComponent(url.pathname.slice('/poster/'.length).replace(/\.jpg$/i, '')));
    return;
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.indexOf('/media/') === 0) {
    serveLocalVideo(req, res, decodeURIComponent(url.pathname.slice('/media/'.length)));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/brands') {
    json(res, 200, { ok: true, brands: db.brands });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/videos') {
    const videos = db.videos.filter((item) => item.status === 'published');
    json(res, 200, { ok: true, videos });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/search') {
    const q = url.searchParams.get('q') || '';
    const videos = searchPublished(db.videos, q, db.synonyms);
    json(res, 200, { ok: true, videos });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, { ok: true, service: 'hqh-preview', port: PORT });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/admin') {
    json(res, 404, { ok: false, message: '浏览器运营页已移除，请用小程序 pages/admin' });
    return;
  }
  if (req.method === 'OPTIONS' && url.pathname === '/api/ai-search') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    });
    res.end();
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/ai-search') {
    readBody(req)
      .then((body) => {
        let index = { videos: [], segments: [] };
        if (fs.existsSync(AI_INDEX_PATH)) {
          try {
            index = JSON.parse(fs.readFileSync(AI_INDEX_PATH, 'utf8'));
          } catch (error) {
            json(res, 200, { ok: false, code: 'NO_INDEX', message: 'ai-index.json 无法解析，请重跑 embed-catalog.js' });
            return null;
          }
        }
        return runAiSearch({
          query: body.query,
          brandId: body.brandId,
          index,
          catalogVideos: db.videos,
          chatJson,
          embedTexts,
          timeoutMs: 20000,
        });
      })
      .then((out) => {
        if (!out) {
          return;
        }
        json(res, 200, out);
      })
      .catch((error) => {
        const code = error.code || 'AI_FAIL';
        let message = error.message || 'AI 搜索失败';
        if (code === 'NO_API_KEY') {
          message = '未配置 OPENAI_API_KEY';
        } else if (code === 'NO_API_BASE') {
          message = '未配置 OPENAI_BASE_URL';
        }
        json(res, 200, { ok: false, code, message });
      });
    return;
  }

  const adminToken = req.headers['x-admin-token'];
  const isAdmin = adminToken === 'preview-admin';

  if (req.method === 'POST' && url.pathname.startsWith('/api/admin/')) {
    readBody(req)
      .then((body) => {
        if (url.pathname === '/api/admin/login') {
          if (body.pin !== 'dev') {
            json(res, 200, { ok: false, message: '口令不正确' });
            return;
          }
          json(res, 200, { ok: true, token: 'preview-admin' });
          return;
        }
        if (!isAdmin) {
          json(res, 200, { ok: false, message: 'UNAUTHORIZED', code: 'UNAUTHORIZED' });
          return;
        }
        if (url.pathname === '/api/admin/seed') {
          db = loadCatalog();
          ensurePosters();
          json(res, 200, { ok: true });
          return;
        }
        if (url.pathname === '/api/admin/brand') {
          const name = String(body.name || '').trim();
          if (!name) {
            json(res, 200, { ok: false, message: '品牌名必填' });
            return;
          }
          const sort = Number(body.sort);
          if (body.id) {
            const found = db.brands.find((item) => item._id === body.id);
            if (!found) {
              json(res, 200, { ok: false, message: '品牌不存在' });
              return;
            }
            found.name = name;
            found.sort = Number.isFinite(sort) ? sort : found.sort || 99;
            db.videos.forEach((video) => {
              if (video.brandId === found._id) {
                video.brandName = name;
                video.searchBlob = buildSearchBlob(video);
              }
            });
            persistCatalog();
            json(res, 200, { ok: true, id: found._id });
            return;
          }
          const row = { _id: newId('b_'), name, sort: Number.isFinite(sort) ? sort : 99 };
          db.brands.push(row);
          persistCatalog();
          json(res, 200, { ok: true, id: row._id });
          return;
        }
        if (url.pathname === '/api/admin/brand-delete') {
          const idx = db.brands.findIndex((item) => item._id === body.id);
          if (idx < 0) {
            json(res, 200, { ok: false, message: '品牌不存在' });
            return;
          }
          const count = db.videos.filter((item) => item.brandId === body.id).length;
          if (count > 0) {
            json(res, 200, { ok: false, message: `该品牌下还有 ${count} 条视频，请先删除视频` });
            return;
          }
          db.products = db.products.filter((item) => item.brandId !== body.id);
          db.brands.splice(idx, 1);
          persistCatalog();
          json(res, 200, { ok: true });
          return;
        }
        if (url.pathname === '/api/admin/synonym') {
          db.synonyms.push({
            alias: String(body.alias || '').trim(),
            canonical: String(body.canonical || '').trim(),
          });
          persistCatalog();
          json(res, 200, { ok: true });
          return;
        }
        if (url.pathname === '/api/admin/video') {
          const brand = db.brands.find((item) => item._id === body.brandId);
          if (!brand || !String(body.title || '').trim()) {
            json(res, 200, { ok: false, message: '标题与品牌必填' });
            return;
          }
          const tags = String(body.tags || '')
            .split(/[,，\s]+/)
            .filter(Boolean);
          const prev = body.id ? db.videos.find((item) => item._id === body.id) : null;
          const payload = {
            title: String(body.title).trim(),
            intro: String(body.intro || '').trim(),
            brandId: brand._id,
            brandName: brand.name,
            productId: '',
            modelName: String(body.modelName || '').trim(),
            tags,
            coverFileId: (prev && prev.coverFileId) || '',
            videoFileId: (prev && prev.videoFileId) || '',
            localFile: (prev && prev.localFile) || '',
            durationSec: prev && prev.durationSec,
            note: prev && prev.note,
            coverCustom: prev && prev.coverCustom,
            transcript: (prev && prev.transcript) || '',
            transcriptSegments: (prev && prev.transcriptSegments) || [],
            searchAbstract: (prev && prev.searchAbstract) || '',
            entities: (prev && prev.entities) || { models: [], actions: [], menus: [], aliases: [] },
            status: 'draft',
            publishedAt: 0,
          };
          payload.searchBlob = buildSearchBlob(payload);
          if (body.id) {
            const idx = db.videos.findIndex((item) => item._id === body.id);
            if (idx >= 0) {
              payload._id = body.id;
              payload.status = db.videos[idx].status;
              payload.publishedAt = db.videos[idx].publishedAt;
              db.videos[idx] = payload;
              persistCatalog();
              ensurePosters();
              json(res, 200, { ok: true, id: body.id });
              return;
            }
          }
          payload._id = newId('v_');
          db.videos.push(payload);
          persistCatalog();
          ensurePosters();
          json(res, 200, { ok: true, id: payload._id });
          return;
        }
        if (url.pathname === '/api/admin/publish') {
          const doc = db.videos.find((item) => item._id === body.id);
          if (!doc) {
            json(res, 200, { ok: false, message: 'NOT_FOUND' });
            return;
          }
          doc.status = 'published';
          doc.publishedAt = Date.now();
          persistCatalog();
          json(res, 200, { ok: true });
          return;
        }
        if (url.pathname === '/api/admin/cover-frame') {
          const doc = db.videos.find((item) => item._id === body.id);
          if (!doc) {
            json(res, 200, { ok: false, message: '请先保存这条视频' });
            return;
          }
          try {
            extractCoverFrame(doc, body.timeSec);
            json(res, 200, { ok: true, posterUrl: doc.posterUrl });
          } catch (error) {
            json(res, 200, { ok: false, message: error.message || '截帧失败' });
          }
          return;
        }
        if (url.pathname === '/api/admin/cover-photo') {
          const doc = db.videos.find((item) => item._id === body.id);
          if (!doc) {
            json(res, 200, { ok: false, message: '请先保存这条视频' });
            return;
          }
          try {
            writeCoverImage(doc, body.image);
            json(res, 200, { ok: true, posterUrl: doc.posterUrl });
          } catch (error) {
            json(res, 200, { ok: false, message: error.message || '封面保存失败' });
          }
          return;
        }
        json(res, 404, { ok: false, message: 'not found' });
      })
      .catch(() => json(res, 400, { ok: false, message: 'bad json' }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/videos') {
    if (!isAdmin) {
      json(res, 200, { ok: false, message: 'UNAUTHORIZED', code: 'UNAUTHORIZED' });
      return;
    }
    json(res, 200, { ok: true, videos: db.videos });
    return;
  }

  json(res, 404, { ok: false, message: 'not found' });
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}


server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(
    `优度本地片源 http://127.0.0.1:${PORT}/media/ …（无浏览器页，请用微信开发者工具）\n`,
  );
});
