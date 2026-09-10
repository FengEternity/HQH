'use strict';

const cloud = require('wx-server-sdk');
const { buildSearchBlob, searchPublished } = require('./lib/catalogSearch');
const { issueTicket, verifyTicket } = require('./lib/ticket');
const {
  assertVideoDraftFields,
  assertReadyToPublish,
  nextStatusAfterSave,
} = require('./lib/videoPublishGate');
const { ensureCollections, runWithCollections } = require('./lib/ensureCollections');
const { attachPosterUrls, resolveMediaUrls } = require('./lib/resolveMediaUrls');
const { listHomeCatalog } = require('./lib/listHome');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const TICKET_TTL_MS = 12 * 60 * 60 * 1000;

function publicVideo(doc) {
  if (!doc) {
    return null;
  }
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
    searchAbstract: doc.searchAbstract || '',
    entities: doc.entities || { models: [], actions: [], menus: [], aliases: [] },
    status: doc.status,
    publishedAt: doc.publishedAt || 0,
  };
}

function withCoverPosters(videos) {
  return attachPosterUrls(videos, (payload) => cloud.getTempFileURL(payload));
}

async function requireAdmin(ticket) {
  const pin = process.env.ADMIN_PIN;
  if (!verifyTicket(pin, ticket)) {
    const err = new Error('UNAUTHORIZED');
    err.code = 'UNAUTHORIZED';
    throw err;
  }
}

async function checkText(content) {
  if (process.env.SKIP_CONTENT_CHECK === '1') {
    return;
  }
  const text = String(content || '').trim();
  if (!text) {
    return;
  }
  const wxContext = cloud.getWXContext();
  const result = await cloud.openapi.security.msgSecCheck({
    openid: wxContext.OPENID,
    scene: 1,
    version: 2,
    content: text,
  });
  const suggest = result && result.result && result.result.suggest;
  if (result.errCode && result.errCode !== 0) {
    const err = new Error('内容安全校验失败');
    err.code = 'CONTENT_REJECTED';
    throw err;
  }
  if (suggest && suggest !== 'pass') {
    const err = new Error('文案未通过内容安全检测，请修改后上架');
    err.code = 'CONTENT_REJECTED';
    throw err;
  }
}

async function dispatch(event) {
  const action = event && event.action;
  switch (action) {
    case 'ping':
      return { ok: true };
    case 'initDb':
      return await initDb();
    case 'adminLogin':
      return await adminLogin(event);
    case 'listBrands':
      return await listBrands();
    case 'listHome':
      return await listHome();
    case 'adminListBrands':
      return await adminListBrands(event);
    case 'listPublished':
      return await listPublished(event);
    case 'getVideo':
      return await getVideo(event);
    case 'search':
      return await search(event);
    case 'adminListVideos':
      return await adminListVideos(event);
    case 'adminGetVideo':
      return await adminGetVideo(event);
    case 'upsertBrand':
      return await upsertBrand(event);
    case 'deleteBrand':
      return await deleteBrand(event);
    case 'upsertProduct':
      return await upsertProduct(event);
    case 'upsertSynonym':
      return await upsertSynonym(event);
    case 'upsertVideo':
      return await upsertVideo(event);
    case 'publishVideo':
      return await publishVideo(event);
    case 'unpublishVideo':
      return await unpublishVideo(event);
    case 'deleteVideo':
      return await deleteVideo(event);
    case 'submitSupport':
      return await submitSupport(event);
    case 'adminListSupport':
      return await adminListSupport(event);
    case 'adminReadSupport':
      return await adminReadSupport(event);
    default: {
      const err = new Error('UNKNOWN_ACTION');
      err.code = 'UNKNOWN_ACTION';
      throw err;
    }
  }
}

exports.main = async (event) => {
  try {
    const action = event && event.action;
    if (action === 'ping' || action === 'initDb') {
      return await dispatch(event);
    }
    return await runWithCollections(db, () => dispatch(event));
  } catch (error) {
    return {
      ok: false,
      code: error.code || 'FAIL',
      message: error.message || 'FAIL',
    };
  }
};

async function initDb() {
  const result = await ensureCollections(db);
  return { ok: true, created: result.created, existed: result.existed };
}

async function adminLogin(event) {
  const pin = process.env.ADMIN_PIN;
  if (!pin || event.pin !== pin) {
    const err = new Error('口令不正确');
    err.code = 'BAD_PIN';
    throw err;
  }
  return { ok: true, ticket: issueTicket(pin, TICKET_TTL_MS) };
}

async function listBrands() {
  const res = await db.collection('brands').orderBy('sort', 'asc').get();
  return { ok: true, brands: res.data };
}

async function listHome() {
  return listHomeCatalog({
    listBrands,
    listPublished: (event) => listPublished(event || {}),
  });
}

async function adminListBrands(event) {
  await requireAdmin(event.ticket);
  const [brandRes, videoRes] = await Promise.all([
    db.collection('brands').orderBy('sort', 'asc').get(),
    db.collection('videos').field({ brandId: true }).limit(1000).get(),
  ]);
  const counts = {};
  for (const video of videoRes.data || []) {
    const brandId = video.brandId;
    if (!brandId) {
      continue;
    }
    counts[brandId] = (counts[brandId] || 0) + 1;
  }
  const brands = (brandRes.data || []).map((brand) =>
    Object.assign({}, brand, { videoCount: counts[brand._id] || 0 }),
  );
  return { ok: true, brands };
}

async function listPublished(event) {
  const where = { status: 'published' };
  if (event.brandId) {
    where.brandId = event.brandId;
  }
  if (event.productId) {
    where.productId = event.productId;
  }
  // 列表不拉口播全文 / searchBlob，否则上传后首页会越来越慢
  const res = await db
    .collection('videos')
    .where(where)
    .orderBy('publishedAt', 'desc')
    .field({
      title: true,
      intro: true,
      brandId: true,
      brandName: true,
      productId: true,
      modelName: true,
      tags: true,
      coverFileId: true,
      videoFileId: true,
      status: true,
      publishedAt: true,
    })
    .limit(100)
    .get();
  let list = res.data.map(publicVideo);
  if (event.tag) {
    list = list.filter((item) => (item.tags || []).includes(event.tag));
  }
  return { ok: true, videos: await withCoverPosters(list) };
}

async function getVideo(event) {
  const snap = await db.collection('videos').doc(event.id).get();
  const doc = snap.data;
  if (!doc || doc.status !== 'published') {
    const err = new Error('NOT_FOUND');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const video = publicVideo(doc);
  // 服务端换临时链，绕过客户端「仅创建者可读写」存储权限；免费环境不必改成全员可读
  const media = await resolveMediaUrls(
    { videoFileId: video.videoFileId, coverFileId: video.coverFileId },
    (payload) => cloud.getTempFileURL(payload),
  );
  return {
    ok: true,
    video: Object.assign({}, video, {
      posterUrl: media.posterUrl || '',
    }),
    videoUrl: media.videoUrl,
  };
}

async function loadSynonyms() {
  const res = await db.collection('synonyms').limit(200).get();
  return res.data;
}

async function search(event) {
  const query = String(event.query || '').trim();
  if (!query) {
    return { ok: true, videos: [] };
  }
  const [published, synonyms] = await Promise.all([
    db
      .collection('videos')
      .where({ status: 'published' })
      .field({
        title: true,
        intro: true,
        brandId: true,
        brandName: true,
        productId: true,
        modelName: true,
        tags: true,
        coverFileId: true,
        videoFileId: true,
        status: true,
        publishedAt: true,
        searchBlob: true,
        searchAbstract: true,
      })
      .limit(1000)
      .get(),
    loadSynonyms(),
  ]);
  const hits = searchPublished(published.data, query, synonyms);
  return { ok: true, videos: await withCoverPosters(hits.map(publicVideo)) };
}

async function adminListVideos(event) {
  await requireAdmin(event.ticket);
  const brandId = String(event.brandId || '').trim();
  if (!brandId) {
    const err = new Error('请选择品牌');
    err.code = 'BAD_INPUT';
    throw err;
  }
  const res = await db
    .collection('videos')
    .where({ brandId })
    .orderBy('updatedAt', 'desc')
    .field({
      title: true,
      intro: true,
      brandId: true,
      brandName: true,
      productId: true,
      modelName: true,
      tags: true,
      coverFileId: true,
      videoFileId: true,
      status: true,
      publishedAt: true,
      updatedAt: true,
    })
    .limit(100)
    .get();
  return { ok: true, videos: await withCoverPosters(res.data) };
}

async function adminGetVideo(event) {
  await requireAdmin(event.ticket);
  const snap = await db.collection('videos').doc(event.id).get();
  const doc = snap.data;
  if (!doc) {
    const err = new Error('NOT_FOUND');
    err.code = 'NOT_FOUND';
    throw err;
  }
  return { ok: true, video: doc };
}

async function upsertBrand(event) {
  await requireAdmin(event.ticket);
  const name = String(event.name || '').trim();
  if (!name) {
    const err = new Error('品牌名必填');
    err.code = 'BAD_INPUT';
    throw err;
  }
  const sort = Number(event.sort);
  const data = { name, sort: Number.isFinite(sort) ? sort : 99 };
  if (event.id) {
    const snap = await db.collection('brands').doc(event.id).get();
    if (!snap.data) {
      const err = new Error('品牌不存在');
      err.code = 'NOT_FOUND';
      throw err;
    }
    await db.collection('brands').doc(event.id).update({ data });
    if (snap.data.name !== name) {
      await syncBrandName(event.id, name);
    }
    return { ok: true, id: event.id };
  }
  const added = await db.collection('brands').add({ data });
  return { ok: true, id: added._id };
}

// videos 里冗余了 brandName 与 searchBlob，改名后要一并刷新，否则搜索还命中旧名
async function syncBrandName(brandId, name) {
  const res = await db.collection('videos').where({ brandId }).limit(200).get();
  for (const doc of res.data) {
    const merged = Object.assign({}, doc, { brandName: name });
    await db.collection('videos').doc(doc._id).update({
      data: {
        brandName: name,
        searchBlob: buildSearchBlob(merged),
        updatedAt: Date.now(),
      },
    });
  }
}

async function deleteBrand(event) {
  await requireAdmin(event.ticket);
  const id = String(event.id || '').trim();
  const snap = await db.collection('brands').doc(id).get();
  if (!snap.data) {
    const err = new Error('NOT_FOUND');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const counted = await db.collection('videos').where({ brandId: id }).count();
  if (counted.total > 0) {
    const err = new Error(`该品牌下还有 ${counted.total} 条视频，请先删除视频`);
    err.code = 'BRAND_NOT_EMPTY';
    throw err;
  }
  const products = await db.collection('products').where({ brandId: id }).get();
  for (const product of products.data) {
    await db.collection('products').doc(product._id).remove();
  }
  await db.collection('brands').doc(id).remove();
  return { ok: true };
}

async function upsertProduct(event) {
  await requireAdmin(event.ticket);
  const name = String(event.name || '').trim();
  const brandId = String(event.brandId || '').trim();
  if (!name || !brandId) {
    const err = new Error('型号与品牌必填');
    err.code = 'BAD_INPUT';
    throw err;
  }
  const data = { name, brandId };
  if (event.id) {
    await db.collection('products').doc(event.id).update({ data });
    return { ok: true, id: event.id };
  }
  const added = await db.collection('products').add({ data });
  return { ok: true, id: added._id };
}

async function upsertSynonym(event) {
  await requireAdmin(event.ticket);
  const alias = String(event.alias || '').trim();
  const canonical = String(event.canonical || '').trim();
  if (!alias || !canonical) {
    const err = new Error('别名与规范名必填');
    err.code = 'BAD_INPUT';
    throw err;
  }
  const data = { alias, canonical };
  if (event.id) {
    await db.collection('synonyms').doc(event.id).update({ data });
    return { ok: true, id: event.id };
  }
  const added = await db.collection('synonyms').add({ data });
  return { ok: true, id: added._id };
}

async function upsertVideo(event) {
  await requireAdmin(event.ticket);
  const title = String(event.title || '').trim();
  const brandId = String(event.brandId || '').trim();
  const intro = String(event.intro || '').trim();
  assertVideoDraftFields({ title, intro, brandId });
  const brandSnap = await db.collection('brands').doc(brandId).get();
  const brand = brandSnap.data;
  if (!brand) {
    const err = new Error('品牌不存在');
    err.code = 'BAD_INPUT';
    throw err;
  }
  let modelName = String(event.modelName || '').trim();
  const productId = String(event.productId || '').trim();
  if (productId) {
    const productSnap = await db.collection('products').doc(productId).get();
    if (productSnap.data) {
      modelName = productSnap.data.name;
    }
  }
  const tags = Array.isArray(event.tags)
    ? event.tags.map((tag) => String(tag).trim()).filter(Boolean)
    : String(event.tags || '')
        .split(/[,，\s]+/)
        .map((tag) => tag.trim())
        .filter(Boolean);
  const prevData = event.id ? (await db.collection('videos').doc(event.id).get()).data : null;
  const payload = {
    title,
    intro,
    brandId,
    brandName: brand.name,
    productId,
    modelName,
    tags,
    coverFileId: event.coverFileId || (prevData && prevData.coverFileId) || '',
    videoFileId: event.videoFileId || (prevData && prevData.videoFileId) || '',
    transcript: event.transcript || (prevData && prevData.transcript) || '',
    transcriptSegments: event.transcriptSegments || (prevData && prevData.transcriptSegments) || [],
    searchAbstract: event.searchAbstract || (prevData && prevData.searchAbstract) || '',
    entities: event.entities || (prevData && prevData.entities) || {
      models: [],
      actions: [],
      menus: [],
      aliases: [],
    },
    status: 'draft',
    searchBlob: '',
    updatedAt: Date.now(),
  };
  payload.searchBlob = buildSearchBlob(payload);
  if (event.id) {
    payload.status = nextStatusAfterSave(prevData && prevData.status);
    await db.collection('videos').doc(event.id).update({ data: payload });
    return { ok: true, id: event.id };
  }
  payload.createdAt = Date.now();
  payload.publishedAt = 0;
  const added = await db.collection('videos').add({ data: payload });
  return { ok: true, id: added._id };
}

async function publishVideo(event) {
  await requireAdmin(event.ticket);
  const snap = await db.collection('videos').doc(event.id).get();
  const doc = snap.data;
  if (!doc) {
    const err = new Error('NOT_FOUND');
    err.code = 'NOT_FOUND';
    throw err;
  }
  assertReadyToPublish(doc);
  await checkText(`${doc.title}\n${doc.intro}`);
  await db.collection('videos').doc(event.id).update({
    data: {
      status: 'published',
      publishedAt: Date.now(),
      updatedAt: Date.now(),
    },
  });
  return { ok: true };
}

async function unpublishVideo(event) {
  await requireAdmin(event.ticket);
  const snap = await db.collection('videos').doc(event.id).get();
  if (!snap.data) {
    const err = new Error('NOT_FOUND');
    err.code = 'NOT_FOUND';
    throw err;
  }
  await db.collection('videos').doc(event.id).update({
    data: {
      status: 'unpublished',
      updatedAt: Date.now(),
    },
  });
  return { ok: true };
}

async function deleteVideo(event) {
  await requireAdmin(event.ticket);
  const snap = await db.collection('videos').doc(event.id).get();
  const doc = snap.data;
  if (!doc) {
    const err = new Error('NOT_FOUND');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const fileList = [doc.coverFileId, doc.videoFileId].filter(Boolean);
  if (fileList.length) {
    try {
      await cloud.deleteFile({ fileList });
    } catch (error) {
      // File may already be gone; still drop the record.
    }
  }
  await db.collection('videos').doc(event.id).remove();
  return { ok: true };
}

async function submitSupport(event) {
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
  await checkText(text);
  const wxContext = cloud.getWXContext();
  const added = await db.collection('support_messages').add({
    data: {
      text,
      account: String(event.account || '').trim(),
      kind: String(event.kind || 'typed'),
      status: 'unread',
      openid: wxContext.OPENID || '',
      createdAt: Date.now(),
    },
  });
  return { ok: true, id: added._id };
}

async function adminListSupport(event) {
  await requireAdmin(event.ticket);
  const res = await db.collection('support_messages').orderBy('createdAt', 'desc').limit(100).get();
  const messages = res.data || [];
  return {
    ok: true,
    messages,
    unreadCount: messages.filter((item) => item.status === 'unread').length,
  };
}

async function adminReadSupport(event) {
  await requireAdmin(event.ticket);
  const snap = await db.collection('support_messages').doc(event.id).get();
  if (!snap.data) {
    const err = new Error('NOT_FOUND');
    err.code = 'NOT_FOUND';
    throw err;
  }
  await db.collection('support_messages').doc(event.id).update({
    data: { status: 'read' },
  });
  return { ok: true };
}

module.exports.publicVideo = publicVideo;
