const MAX_INTRO_LENGTH = 400;
const PHRASE_LENGTH = 3;
const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]+/g;
const ALPHANUMERIC_PATTERN = /[A-Za-z][A-Za-z0-9]+|[0-9]+[A-Za-z][A-Za-z0-9]*/g;

function issue(code, message) {
  return { code, message };
}

function normalizeIntro(intro) {
  if (typeof intro !== 'string') {
    return '';
  }
  return intro.replace(/\s+/g, ' ').trim();
}

function countCharacters(text) {
  return [...text].length;
}

function joinTranscript(transcriptSegments) {
  if (!Array.isArray(transcriptSegments)) {
    return '';
  }
  return transcriptSegments
    .map((segment) => (segment && typeof segment.text === 'string' ? segment.text : ''))
    .join('\n');
}

// 只取长度至少 3 的汉字片段和含字母的型号词，避免「的」「12」这类巧合当成字幕依据。
function collectEvidencePhrases(text) {
  const phrases = new Set();

  for (const run of text.match(CJK_PATTERN) || []) {
    const characters = [...run];
    for (let index = 0; index + PHRASE_LENGTH <= characters.length; index += 1) {
      phrases.add(characters.slice(index, index + PHRASE_LENGTH).join(''));
    }
  }

  for (const token of text.match(ALPHANUMERIC_PATTERN) || []) {
    phrases.add(token.toLowerCase());
  }

  return phrases;
}

function findTranscriptEvidence(intro, transcript) {
  const haystack = transcript.toLowerCase();
  for (const phrase of collectEvidencePhrases(intro)) {
    if (haystack.includes(phrase)) {
      return phrase;
    }
  }
  return '';
}

function validateReviewedIntro({ intro, transcriptSegments, placeholderIntro }) {
  const normalized = normalizeIntro(intro);
  const length = countCharacters(normalized);
  const issues = [];

  if (length === 0) {
    return { valid: false, issues: [issue('EMPTY', '介绍为空')], intro: normalized, length };
  }

  if (normalized === normalizeIntro(placeholderIntro)) {
    issues.push(issue('PLACEHOLDER', '介绍仍是 A1 占位句'));
  }

  if (length > MAX_INTRO_LENGTH) {
    issues.push(
      issue('TOO_LONG', `介绍 ${length} 字，超过 ${MAX_INTRO_LENGTH} 字上限`),
    );
  }

  const transcript = joinTranscript(transcriptSegments);
  if (transcript.trim() === '') {
    issues.push(issue('NO_TRANSCRIPT', '缺少字幕，无法核对介绍'));
  } else if (!findTranscriptEvidence(normalized, transcript)) {
    issues.push(issue('NOT_GROUNDED', '介绍没有任何实词能在字幕中找到'));
  }

  return { valid: issues.length === 0, issues, intro: normalized, length };
}

function resolvePlaceholderIntro(content, title) {
  const draft = content && content[title];
  if (!draft || typeof draft.intro !== 'string' || draft.intro.trim() === '') {
    throw new Error(`缺少 A1 占位介绍：${title}`);
  }
  return draft.intro;
}

function indexReviews(reviews) {
  const bySourceKey = new Map();
  if (!Array.isArray(reviews)) {
    throw new Error('审核稿必须是数组');
  }

  for (const review of reviews) {
    const sourceKey = review && review.sourceKey;
    if (typeof sourceKey !== 'string' || sourceKey.trim() === '') {
      throw new Error('审核稿缺少 sourceKey');
    }
    if (bySourceKey.has(sourceKey)) {
      throw new Error(`审核稿存在重复 sourceKey：${sourceKey}`);
    }
    bySourceKey.set(sourceKey, review);
  }

  return bySourceKey;
}

function keepIntro(entry) {
  return {
    ...entry,
    introStatus: entry.introStatus === 'reviewed' ? 'reviewed' : 'placeholder',
  };
}

function buildIntroPlan({ entries, reviews, content }) {
  if (!Array.isArray(entries)) {
    throw new Error('manifest entries 必须是数组');
  }

  const reviewBySourceKey = indexReviews(reviews);
  const knownSourceKeys = new Set(entries.map((entry) => entry.sourceKey));
  const unknownSourceKeys = [...reviewBySourceKey.keys()].filter(
    (sourceKey) => !knownSourceKeys.has(sourceKey),
  );
  const results = [];

  const nextEntries = entries.map((entry) => {
    const placeholderIntro = resolvePlaceholderIntro(content, entry.title);
    const review = reviewBySourceKey.get(entry.sourceKey);
    const base = { sourceKey: entry.sourceKey, title: entry.title };

    if (!review) {
      results.push({
        ...base,
        action: 'skipped',
        issues: [issue('NO_REVIEW', '未提交审核稿')],
        length: 0,
      });
      return keepIntro(entry);
    }

    if (typeof review.title === 'string' && review.title !== entry.title) {
      results.push({
        ...base,
        action: 'rejected',
        issues: [issue('TITLE_MISMATCH', `审核稿标题为 ${review.title}`)],
        length: 0,
      });
      return keepIntro(entry);
    }

    const status = (entry.transcription && entry.transcription.status) || '';
    if (status !== 'ready') {
      results.push({
        ...base,
        action: 'rejected',
        issues: [issue('NOT_READY', `字幕状态为 ${status || '未转写'}`)],
        length: 0,
      });
      return keepIntro(entry);
    }

    const validation = validateReviewedIntro({
      intro: review.intro,
      transcriptSegments: entry.transcriptSegments,
      placeholderIntro,
    });
    if (!validation.valid) {
      results.push({
        ...base,
        action: 'rejected',
        issues: validation.issues,
        length: validation.length,
      });
      return keepIntro(entry);
    }

    results.push({ ...base, action: 'applied', issues: [], length: validation.length });
    return { ...entry, intro: validation.intro, introStatus: 'reviewed' };
  });

  const countOf = (action) => results.filter((result) => result.action === action).length;

  return {
    entries: nextEntries,
    results,
    unknownSourceKeys,
    appliedCount: countOf('applied'),
    rejectedCount: countOf('rejected'),
    skippedCount: countOf('skipped'),
  };
}

module.exports = {
  MAX_INTRO_LENGTH,
  buildIntroPlan,
  normalizeIntro,
  validateReviewedIntro,
};
