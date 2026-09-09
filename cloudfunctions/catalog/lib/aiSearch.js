'use strict';

const VIDEO_TEXT_MAX = 8000;
const EXCERPT_MAX = 40;
const TOP_VIDEO = 8;
const TOP_SEGMENT = 8;
const TOP_MERGE = 5;

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

function clipText(value, max) {
  const text = String(value || '').trim();
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max);
}

function videoIndexText(video) {
  const abstract = String((video && video.searchAbstract) || '').trim();
  if (abstract) {
    return clipText(abstract, VIDEO_TEXT_MAX);
  }
  return clipText(
    [video && video.title, video && video.intro, video && video.transcript].filter(Boolean).join('\n'),
    VIDEO_TEXT_MAX,
  );
}

function excerpt(text, maxLen) {
  const limit = maxLen == null ? EXCERPT_MAX : maxLen;
  return clipText(text, limit);
}

function formatStartLabel(sec) {
  if (sec == null || sec === '' || Number.isNaN(Number(sec))) {
    return '';
  }
  const total = Math.max(0, Math.floor(Number(sec)));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return '约 ' + m + ':' + String(s).padStart(2, '0');
}

function topK(items, k) {
  const list = (items || []).slice();
  list.sort((a, b) => (b.score || 0) - (a.score || 0));
  return list.slice(0, k);
}

function sanitizeStartSec(requested, candidateSecs) {
  const candidates = (candidateSecs || [])
    .map((item) => Number(item))
    .filter((item) => !Number.isNaN(item) && item >= 0);
  if (!candidates.length) {
    return 0;
  }
  const want = Number(requested);
  if (!Number.isNaN(want) && candidates.indexOf(want) >= 0) {
    return want;
  }
  return candidates[0];
}

function catalogById(catalogVideos) {
  const map = {};
  (catalogVideos || []).forEach((item) => {
    if (item && item._id) {
      map[item._id] = item;
    }
  });
  return map;
}

function filterIndexByBrand(index, catalogVideos, brandId) {
  const id = String(brandId || '').trim();
  if (!id) {
    return index;
  }
  const docs = catalogById(catalogVideos);
  const videos = (index.videos || []).filter((row) => docs[row._id] && docs[row._id].brandId === id);
  const allowed = {};
  videos.forEach((row) => {
    allowed[row._id] = true;
  });
  const segments = (index.segments || []).filter((row) => allowed[row.videoId]);
  return { model: index.model, updatedAt: index.updatedAt, videos, segments };
}

function mergeVideoScores(videoHits, segmentHits) {
  const byId = {};
  (videoHits || []).forEach((hit) => {
    const videoId = hit.videoId || hit._id;
    if (!videoId) {
      return;
    }
    byId[videoId] = {
      videoId,
      videoScore: hit.score || 0,
      bestSegment: null,
    };
  });
  (segmentHits || []).forEach((hit) => {
    const videoId = hit.videoId;
    if (!videoId) {
      return;
    }
    if (!byId[videoId]) {
      byId[videoId] = { videoId, videoScore: 0, bestSegment: null };
    }
    const prev = byId[videoId].bestSegment;
    if (!prev || (hit.score || 0) > (prev.score || 0)) {
      byId[videoId].bestSegment = hit;
    }
  });
  return Object.keys(byId)
    .map((videoId) => {
      const row = byId[videoId];
      const score = row.bestSegment
        ? 0.6 * row.videoScore + 0.4 * (row.bestSegment.score || 0)
        : row.videoScore;
      return {
        videoId,
        score,
        bestSegment: row.bestSegment,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function applyLlmPicks(ranked, llmPicks) {
  const pickMap = {};
  (llmPicks || []).forEach((pick) => {
    if (pick && pick._id) {
      pickMap[pick._id] = pick;
    }
  });
  return ranked.map((row) => {
    const pick = pickMap[row.videoId] || {};
    const candidateSecs = (row.segments || [])
      .map((seg) => Number(seg.startSec))
      .filter((sec) => !Number.isNaN(sec));
    const startSec = candidateSecs.length
      ? sanitizeStartSec(pick.startSec, candidateSecs)
      : 0;
    const chosen =
      (row.segments || []).find((seg) => Number(seg.startSec) === startSec) || row.bestSegment || null;
    return Object.assign({}, row, {
      reason: String(pick.reason || ''),
      startSec,
      excerpt: excerpt((chosen && chosen.text) || row.intro || ''),
    });
  });
}

function scoreRows(rows, queryVec, idKey) {
  return (rows || [])
    .map((row) => ({
      row,
      score: cosine(queryVec, row.vector),
    }))
    .filter((item) => item.score > 0)
    .map((item) =>
      Object.assign({}, item.row, {
        score: item.score,
        videoId: idKey === 'video' ? item.row._id : item.row.videoId,
      }),
    );
}

function parseJsonContent(raw) {
  const text = String(raw || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new Error('BAD_JSON');
  }
  return JSON.parse(text.slice(start, end + 1));
}

async function runAiSearch(opts) {
  const query = String((opts && opts.query) || '').trim();
  if (!query) {
    return { ok: false, code: 'BAD_INPUT', message: '请输入问题' };
  }
  const index = (opts && opts.index) || {};
  if (!index.videos || !index.videos.length) {
    return { ok: false, code: 'NO_INDEX', message: '请先运行 node scripts/embed-catalog.js' };
  }
  const catalogVideos = (opts && opts.catalogVideos) || [];
  const chatJson = opts.chatJson;
  const embedTexts = opts.embedTexts;
  const timeoutMs = opts.timeoutMs || 20000;
  const filtered = filterIndexByBrand(index, catalogVideos, opts.brandId);
  if (!filtered.videos.length) {
    return { ok: true, answer: '', videos: [] };
  }

  let searchText = query;
  try {
    const rewritten = await chatJson({
      system:
        '你是测绘仪器讲解资料馆的检索助手。把用户问句改写成 JSON：{"query":"用于语义检索的短句","keywords":["词1","词2"]}。不要编造不存在的型号。',
      user: query,
      timeoutMs: Math.min(8000, timeoutMs),
    });
    if (rewritten && rewritten.query) {
      searchText = String(rewritten.query).trim() || query;
    }
  } catch (error) {
    searchText = query;
  }

  let queryVec;
  try {
    const vectors = await embedTexts([searchText], timeoutMs);
    queryVec = vectors && vectors[0];
  } catch (error) {
    return { ok: false, code: 'EMBED_FAIL', message: error.message || '向量化失败' };
  }
  if (!queryVec) {
    return { ok: false, code: 'EMBED_FAIL', message: '向量化失败' };
  }

  const videoHits = topK(scoreRows(filtered.videos, queryVec, 'video'), TOP_VIDEO);
  const segmentHits = topK(scoreRows(filtered.segments, queryVec, 'segment'), TOP_SEGMENT);
  const merged = mergeVideoScores(videoHits, segmentHits).slice(0, TOP_MERGE);
  const docs = catalogById(catalogVideos);
  const ranked = merged
    .map((row) => {
      const doc = docs[row.videoId];
      if (!doc || doc.status !== 'published') {
        return null;
      }
      const segs = (filtered.segments || []).filter((seg) => seg.videoId === row.videoId);
      return {
        videoId: row.videoId,
        score: row.score,
        bestSegment: row.bestSegment,
        title: doc.title,
        intro: doc.intro,
        brandName: doc.brandName,
        brandId: doc.brandId,
        posterUrl: doc.posterUrl || '',
        modelName: doc.modelName || '',
        tags: doc.tags || [],
        segments: segs.map((seg) => ({
          startSec: seg.startSec,
          endSec: seg.endSec,
          text: seg.text,
        })),
      };
    })
    .filter(Boolean);

  if (!ranked.length) {
    return { ok: true, answer: '', videos: [] };
  }

  let llm = { answer: '', picks: [] };
  try {
    const payload = ranked.map((row) => ({
      _id: row.videoId,
      title: row.title,
      intro: row.intro,
      segments: row.segments.slice(0, 6).map((seg) => ({
        startSec: seg.startSec,
        text: excerpt(seg.text, 80),
      })),
    }));
    llm = await chatJson({
      system:
        '根据候选讲解视频写 JSON：{"answer":"一两句总述","picks":[{"_id":"视频id","reason":"一句为何命中","startSec":秒}]}。startSec 必须是该片 segments 里已有的数字；没有 segments 则 startSec 为 0。不要编造片中没有的内容。',
      user: JSON.stringify({ query, candidates: payload }),
      timeoutMs,
    });
  } catch (error) {
    llm = { answer: '', picks: [] };
  }

  const picked = applyLlmPicks(ranked, llm.picks);
  return {
    ok: true,
    answer: String((llm && llm.answer) || ''),
    videos: picked.map((row) => ({
      _id: row.videoId,
      title: row.title,
      brandName: row.brandName,
      brandId: row.brandId,
      posterUrl: row.posterUrl,
      modelName: row.modelName,
      tags: row.tags,
      startSec: row.startSec,
      startLabel: row.segments && row.segments.length ? formatStartLabel(row.startSec) : '',
      excerpt: row.excerpt,
      reason: row.reason,
      initial: String(row.brandName || '优').slice(0, 1),
    })),
  };
}

module.exports = {
  cosine,
  videoIndexText,
  excerpt,
  formatStartLabel,
  topK,
  sanitizeStartSec,
  filterIndexByBrand,
  mergeVideoScores,
  applyLlmPicks,
  parseJsonContent,
  runAiSearch,
};
