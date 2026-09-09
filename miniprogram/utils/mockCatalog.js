const { buildSearchBlob, searchPublished } = require('./catalogSearch.js');
const {
  assertVideoDraftFields,
  assertReadyToPublish,
  nextStatusAfterSave,
} = require('./videoPublishGate.js');

// 微信开发者工具对 require('*.json') 支持不稳，改为 JS 模块导出
const seedCatalog = require('../data/catalog');

const STORE_KEY = 'hqh_mock_db_v6';
const MOCK_PIN = 'dev';
const MOCK_TICKET = 'mock-ticket';

function hydrateDb(raw) {
  return {
    brands: (raw.brands || []).slice(),
    products: (raw.products || []).slice(),
    videos: (raw.videos || []).map((item) => {
      const video = Object.assign({}, item);
      video.searchBlob = buildSearchBlob(video);
      return video;
    }),
    synonyms: (raw.synonyms || []).slice(),
    supportMessages: (raw.supportMessages || []).slice(),
  };
}

function defaultDb() {
  return hydrateDb(seedCatalog);
}

function loadDb() {
  const raw = wx.getStorageSync(STORE_KEY);
  if (raw && raw.brands) {
    return raw;
  }
  const db = defaultDb();
  wx.setStorageSync(STORE_KEY, db);
  return db;
}

function saveDb(db) {
  wx.setStorageSync(STORE_KEY, db);
}

// 同一毫秒连点两次不能撞 id
function newId(prefix) {
  return prefix + Date.now() + Math.random().toString(16).slice(2, 6);
}

function sortedBrands(db) {
  return db.brands.slice().sort((a, b) => (a.sort || 99) - (b.sort || 99));
}

function publicVideo(doc) {
  return {
    _id: doc._id,
    title: doc.title,
    intro: doc.intro,
    brandId: doc.brandId,
    brandName: doc.brandName,
    productId: doc.productId || '',
    modelName: doc.modelName || '',
    tags: doc.tags || [],
    coverFileId: doc.coverFileId || '',
    videoFileId: doc.videoFileId || '',
    localFile: doc.localFile || '',
    posterUrl: doc.localFile
      ? 'http://127.0.0.1:8787/poster/' + doc._id + '.jpg?t=' + (doc.updatedAt || 0)
      : '',
    mediaSrc: doc.localFile
      ? 'http://127.0.0.1:8787/media/' + encodeURIComponent(doc.localFile)
      : '',
    durationSec: doc.durationSec || 0,
    searchAbstract: doc.searchAbstract || '',
    entities: doc.entities || { models: [], actions: [], menus: [], aliases: [] },
    status: doc.status,
    publishedAt: doc.publishedAt || 0,
  };
}

function requireAdmin(ticket) {
  if (ticket !== MOCK_TICKET) {
    const err = new Error('UNAUTHORIZED');
    err.code = 'UNAUTHORIZED';
    throw err;
  }
}

function handle(event) {
  const db = loadDb();
  const action = event.action;
  switch (action) {
    case 'ping':
      return { ok: true, mock: true };
    case 'adminLogin':
      if (event.pin !== MOCK_PIN) {
        const err = new Error('口令不正确（本地模拟口令是 dev）');
        err.code = 'BAD_PIN';
        throw err;
      }
      return { ok: true, ticket: MOCK_TICKET, mock: true };
    case 'seed':
      requireAdmin(event.ticket);
      saveDb(defaultDb());
      return { ok: true, mock: true };
    case 'listBrands':
      return { ok: true, brands: sortedBrands(db) };
    case 'adminListBrands':
      requireAdmin(event.ticket);
      return {
        ok: true,
        brands: sortedBrands(db).map((brand) =>
          Object.assign({}, brand, {
            videoCount: db.videos.filter((item) => item.brandId === brand._id).length,
          }),
        ),
      };
    case 'listPublished': {
      let list = db.videos.filter((item) => item.status === 'published');
      if (event.brandId) {
        list = list.filter((item) => item.brandId === event.brandId);
      }
      if (event.productId) {
        list = list.filter((item) => item.productId === event.productId);
      }
      if (event.tag) {
        list = list.filter((item) => (item.tags || []).includes(event.tag));
      }
      list.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
      return { ok: true, videos: list.map(publicVideo) };
    }
    case 'getVideo': {
      const doc = db.videos.find((item) => item._id === event.id);
      if (!doc || doc.status !== 'published') {
        const err = new Error('NOT_FOUND');
        err.code = 'NOT_FOUND';
        throw err;
      }
      return { ok: true, video: publicVideo(doc) };
    }
    case 'search':
      return {
        ok: true,
        videos: searchPublished(db.videos, event.query, db.synonyms).map(publicVideo),
      };
    case 'adminListVideos': {
      requireAdmin(event.ticket);
      const brandId = String(event.brandId || '').trim();
      if (!brandId) {
        const err = new Error('请选择品牌');
        err.code = 'BAD_INPUT';
        throw err;
      }
      return { ok: true, videos: db.videos.filter((item) => item.brandId === brandId).map((item) => publicVideo(item)) };
    }
    case 'adminGetVideo': {
      requireAdmin(event.ticket);
      const doc = db.videos.find((item) => item._id === event.id);
      if (!doc) {
        const err = new Error('NOT_FOUND');
        err.code = 'NOT_FOUND';
        throw err;
      }
      return { ok: true, video: Object.assign({}, doc, publicVideo(doc)) };
    }
    case 'upsertBrand': {
      requireAdmin(event.ticket);
      const name = String(event.name || '').trim();
      if (!name) {
        const err = new Error('品牌名必填');
        err.code = 'BAD_INPUT';
        throw err;
      }
      const sort = Number(event.sort);
      if (event.id) {
        const found = db.brands.find((item) => item._id === event.id);
        if (!found) {
          const err = new Error('品牌不存在');
          err.code = 'NOT_FOUND';
          throw err;
        }
        found.name = name;
        found.sort = Number.isFinite(sort) ? sort : found.sort || 99;
        db.videos.forEach((video) => {
          if (video.brandId !== found._id) {
            return;
          }
          video.brandName = name;
          video.searchBlob = buildSearchBlob(video);
        });
        saveDb(db);
        return { ok: true, id: found._id };
      }
      const row = { _id: newId('b_'), name, sort: Number.isFinite(sort) ? sort : 99 };
      db.brands.push(row);
      saveDb(db);
      return { ok: true, id: row._id };
    }
    case 'deleteBrand': {
      requireAdmin(event.ticket);
      const idx = db.brands.findIndex((item) => item._id === event.id);
      if (idx < 0) {
        const err = new Error('NOT_FOUND');
        err.code = 'NOT_FOUND';
        throw err;
      }
      const count = db.videos.filter((item) => item.brandId === event.id).length;
      if (count > 0) {
        const err = new Error(`该品牌下还有 ${count} 条视频，请先删除视频`);
        err.code = 'BRAND_NOT_EMPTY';
        throw err;
      }
      db.products = db.products.filter((item) => item.brandId !== event.id);
      db.brands.splice(idx, 1);
      saveDb(db);
      return { ok: true };
    }
    case 'upsertSynonym': {
      requireAdmin(event.ticket);
      const row = {
        _id: newId('s_'),
        alias: String(event.alias || '').trim(),
        canonical: String(event.canonical || '').trim(),
      };
      db.synonyms.push(row);
      saveDb(db);
      return { ok: true, id: row._id };
    }
    case 'upsertVideo': {
      requireAdmin(event.ticket);
      const brand = db.brands.find((item) => item._id === event.brandId);
      if (!brand) {
        const err = new Error('品牌不存在');
        err.code = 'BAD_INPUT';
        throw err;
      }
      const title = String(event.title || '').trim();
      const intro = String(event.intro || '').trim();
      assertVideoDraftFields({ title, intro, brandId: brand._id });
      const tags = String(event.tags || '')
        .split(/[,，\s]+/)
        .filter(Boolean);
      const prev = event.id ? db.videos.find((item) => item._id === event.id) : null;
      const payload = {
        title,
        intro,
        brandId: brand._id,
        brandName: brand.name,
        productId: event.productId || '',
        modelName: event.modelName || '',
        tags,
        coverFileId: event.coverFileId || (prev && prev.coverFileId) || '',
        videoFileId: event.videoFileId || (prev && prev.videoFileId) || '',
        localFile: event.localFile || (prev && prev.localFile) || '',
        durationSec: prev && prev.durationSec,
        note: prev && prev.note,
        coverCustom: prev && prev.coverCustom,
        transcript: prev && prev.transcript,
        transcriptSegments: prev && prev.transcriptSegments,
        searchAbstract: prev && prev.searchAbstract,
        entities: prev && prev.entities,
        status: 'draft',
        publishedAt: 0,
        updatedAt: Date.now(),
      };
      payload.searchBlob = buildSearchBlob(payload);
      if (event.id) {
        const idx = db.videos.findIndex((item) => item._id === event.id);
        if (idx >= 0) {
          payload.status = nextStatusAfterSave(db.videos[idx].status);
          payload.publishedAt = db.videos[idx].publishedAt;
          payload._id = event.id;
          db.videos[idx] = payload;
          saveDb(db);
          return { ok: true, id: event.id };
        }
      }
      payload._id = newId('v_');
      db.videos.push(payload);
      saveDb(db);
      return { ok: true, id: payload._id };
    }
    case 'publishVideo': {
      requireAdmin(event.ticket);
      const doc = db.videos.find((item) => item._id === event.id);
      if (!doc) {
        const err = new Error('NOT_FOUND');
        err.code = 'NOT_FOUND';
        throw err;
      }
      assertReadyToPublish(doc);
      doc.status = 'published';
      doc.publishedAt = Date.now();
      saveDb(db);
      return { ok: true };
    }
    case 'unpublishVideo': {
      requireAdmin(event.ticket);
      const doc = db.videos.find((item) => item._id === event.id);
      if (!doc) {
        const err = new Error('NOT_FOUND');
        err.code = 'NOT_FOUND';
        throw err;
      }
      doc.status = 'unpublished';
      doc.updatedAt = Date.now();
      saveDb(db);
      return { ok: true };
    }
    case 'deleteVideo': {
      requireAdmin(event.ticket);
      const idx = db.videos.findIndex((item) => item._id === event.id);
      if (idx < 0) {
        const err = new Error('NOT_FOUND');
        err.code = 'NOT_FOUND';
        throw err;
      }
      db.videos.splice(idx, 1);
      saveDb(db);
      return { ok: true };
    }
    case 'submitSupport': {
      const text = String(event.text || '').trim();
      if (!text) {
        const err = new Error('请输入内容');
        err.code = 'BAD_INPUT';
        throw err;
      }
      if (text.length > 500) {
        const err = new Error('内容太长');
        err.code = 'BAD_INPUT';
        throw err;
      }
      const row = {
        _id: newId('t_'),
        text,
        account: String(event.account || '').trim(),
        kind: String(event.kind || 'typed'),
        status: 'unread',
        createdAt: Date.now(),
      };
      db.supportMessages = db.supportMessages || [];
      db.supportMessages.push(row);
      saveDb(db);
      return { ok: true, id: row._id };
    }
    case 'adminListSupport': {
      requireAdmin(event.ticket);
      const list = (db.supportMessages || [])
        .slice()
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return {
        ok: true,
        messages: list,
        unreadCount: list.filter((item) => item.status === 'unread').length,
      };
    }
    case 'adminReadSupport': {
      requireAdmin(event.ticket);
      const found = (db.supportMessages || []).find((item) => item._id === event.id);
      if (!found) {
        const err = new Error('NOT_FOUND');
        err.code = 'NOT_FOUND';
        throw err;
      }
      found.status = 'read';
      saveDb(db);
      return { ok: true };
    }
    default: {
      const err = new Error('UNKNOWN_ACTION');
      err.code = 'UNKNOWN_ACTION';
      throw err;
    }
  }
}

function catalogMock(data) {
  try {
    return Promise.resolve(handle(data));
  } catch (error) {
    return Promise.reject(error);
  }
}

module.exports = { catalogMock };
