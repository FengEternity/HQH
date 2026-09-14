const MAX_INTRO_LENGTH = 400;
const PHRASE_LENGTH = 3;
const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]+/g;
const ALPHANUMERIC_PATTERN = /[A-Za-z][A-Za-z0-9]+|[0-9]+[A-Za-z][A-Za-z0-9]*/g;
// 「（约第 12 秒）」是写作时给的对齐提示，不是内容依据，取证前先剥掉。
const TIMESTAMP_ANNOTATION_PATTERN = /[（(]\s*约?第?\s*[0-9]+(?:\.[0-9]+)?\s*秒\s*[)）]/g;
const SENTENCE_BOUNDARY_PATTERN = /[。！？；;!?\n]+/;
// 关键帧申报的界面词至少两字，避免用单字兜住整句。
const MIN_KEYFRAME_TERM_LENGTH = 2;
// 多数步骤句必须有字幕锚点，关键帧申报最多兜住三分之一。
const TRANSCRIPT_ANCHOR_NUMERATOR = 2;
const TRANSCRIPT_ANCHOR_DENOMINATOR = 3;
const MAX_REPORTED_STEPS = 3;

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

function splitSteps(intro) {
  return intro
    .replace(TIMESTAMP_ANNOTATION_PATTERN, ' ')
    .split(SENTENCE_BOUNDARY_PATTERN)
    .map((step) => step.trim())
    .filter(Boolean);
}

function normalizeKeyframeEvidence(keyframeEvidence) {
  if (!Array.isArray(keyframeEvidence)) {
    return [];
  }
  return keyframeEvidence
    .map((term) => (typeof term === 'string' ? term.trim() : ''))
    .filter((term) => countCharacters(term) >= MIN_KEYFRAME_TERM_LENGTH);
}

// 逐句取证：任意一个三字片段命中就整篇放行，挡不住「开头一句真、后面全编」。
// 规则改为每一步都要有出处，且字幕锚点必须占多数，关键帧只兜少量界面词。
function auditSteps(intro, transcript, keyframeTerms) {
  const steps = splitSteps(intro);
  const anchored = [];
  const keyframeOnly = [];
  const ungrounded = [];

  for (const step of steps) {
    if (findTranscriptEvidence(step, transcript)) {
      anchored.push(step);
    } else if (keyframeTerms.some((term) => step.includes(term))) {
      keyframeOnly.push(step);
    } else {
      ungrounded.push(step);
    }
  }

  const total = steps.length;
  const requiredAnchors = Math.ceil(
    (total * TRANSCRIPT_ANCHOR_NUMERATOR) / TRANSCRIPT_ANCHOR_DENOMINATOR,
  );
  return { total, anchored, keyframeOnly, ungrounded, requiredAnchors };
}

function describeSteps(steps) {
  const shown = steps.slice(0, MAX_REPORTED_STEPS).join(' / ');
  return steps.length > MAX_REPORTED_STEPS ? `${shown} 等 ${steps.length} 句` : shown;
}

function validateReviewedIntro({
  intro,
  transcriptSegments,
  placeholderIntro,
  keyframeEvidence,
}) {
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
  } else {
    const audit = auditSteps(normalized, transcript, normalizeKeyframeEvidence(keyframeEvidence));
    if (audit.anchored.length === 0) {
      issues.push(issue('NOT_GROUNDED', '介绍没有任何实词能在字幕中找到'));
    } else {
      if (audit.ungrounded.length > 0) {
        issues.push(
          issue(
            'UNGROUNDED_STEP',
            `以下步骤句既无字幕依据也未申报关键帧界面词：${describeSteps(audit.ungrounded)}`,
          ),
        );
      }
      if (audit.anchored.length < audit.requiredAnchors) {
        issues.push(
          issue(
            'WEAK_TRANSCRIPT_EVIDENCE',
            `仅 ${audit.anchored.length}/${audit.total} 句命中字幕，至少需要 ${audit.requiredAnchors} 句`,
          ),
        );
      }
    }
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

// 带人工介绍的两种状态：reviewed 是有效稿，needs_review 是已失效但正文还留着。
const HUMAN_INTRO_STATUSES = new Set(['reviewed', 'needs_review']);

// 校验不过的条目必须离开 reviewed，且降级信号要粘滞，否则导入闸门会放过陈旧 intro。
function statusAfterFailure(entry) {
  return HUMAN_INTRO_STATUSES.has(entry.introStatus) ? 'needs_review' : 'placeholder';
}

function checkAgainstTranscript(entry, intro, placeholderIntro, keyframeEvidence) {
  const status = (entry.transcription && entry.transcription.status) || '';
  if (status !== 'ready') {
    return {
      valid: false,
      issues: [issue('NOT_READY', `字幕状态为 ${status || '未转写'}`)],
      intro: '',
      length: 0,
    };
  }

  return validateReviewedIntro({
    intro,
    transcriptSegments: entry.transcriptSegments,
    placeholderIntro,
    keyframeEvidence,
  });
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

    const reject = (issues, length = 0) => {
      results.push({ ...base, action: 'rejected', issues, length });
      return { ...entry, introStatus: statusAfterFailure(entry) };
    };
    const skip = (length) => {
      results.push({
        ...base,
        action: 'skipped',
        issues: [issue('NO_REVIEW', '未提交审核稿')],
        length,
      });
    };

    if (!review) {
      if (!HUMAN_INTRO_STATUSES.has(entry.introStatus)) {
        skip(0);
        return { ...entry, introStatus: 'placeholder' };
      }

      // 带人工介绍的条目按当前字幕复核，字幕回退或旧介绍失效都要降级。
      const recheck = checkAgainstTranscript(
        entry,
        entry.intro,
        placeholderIntro,
        entry.introKeyframeEvidence,
      );
      if (!recheck.valid) {
        return reject(recheck.issues, recheck.length);
      }
      if (entry.introStatus === 'needs_review') {
        // 已判失效的条目只能靠新的合格审核稿恢复，不因复核偶然通过就自愈。
        return reject(
          [issue('NEEDS_NEW_REVIEW', '此前已判需重审，等待新的审核稿')],
          recheck.length,
        );
      }
      skip(recheck.length);
      return { ...entry, introStatus: 'reviewed' };
    }

    if (typeof review.title !== 'string' || review.title.trim() === '') {
      return reject([issue('TITLE_REQUIRED', '审核稿缺少 title，无法核对条目')]);
    }

    if (review.title !== entry.title) {
      return reject([issue('TITLE_MISMATCH', `审核稿标题为 ${review.title}`)]);
    }

    const keyframeEvidence = normalizeKeyframeEvidence(review.keyframeEvidence);
    const validation = checkAgainstTranscript(
      entry,
      review.intro,
      placeholderIntro,
      keyframeEvidence,
    );
    if (!validation.valid) {
      return reject(validation.issues, validation.length);
    }

    results.push({ ...base, action: 'applied', issues: [], length: validation.length });
    // 申报随条目落盘，之后无新稿复核时才不会把当初有据的界面词判成编造。
    return {
      ...entry,
      intro: validation.intro,
      introStatus: 'reviewed',
      introKeyframeEvidence: keyframeEvidence,
    };
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
