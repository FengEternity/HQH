'use strict';

const { hanSyllables, syllableSetsMatch } = require('./hanSyllables');

const MIN_INTRO_LENGTH = 10;
const MAX_INTRO_LENGTH = 160;
const FORMAT_TOKENS = ['csv', 'dat', 'txt', 'xls', 'dxf'];
const CAPABILITY_WORDS = ['有线', '无线', '一键', '蓝牙'];
const BANNED_PHRASES = ['大家好', '点赞', '下期再见'];

const INTRO_SYSTEM_PROMPT = [
  '你是测绘仪器讲解视频的编辑。',
  '根据用户给出的标题、品牌、术语表和口播，只写一段简介正文。',
  '先点明品牌和这期功能，再按口播里的真实顺序写下主要操作。',
  '去掉大家好、点赞、转发、下期再见，以及过细的单次点击。',
  '术语表只用来把口播里听错的词改成正确写法。',
  '术语表里有、但这期标题和口播都没提到的词不要写。',
  '不要补充这期没提到的文件格式、有线、无线、蓝牙或一键。',
  '整段尽量不超过 100 字，不少于 10 字，1 到 4 句。',
  '不要输出标题、解释或引号。',
].join('');

function countCharacters(text) {
  return [...text].length;
}

function isAsciiTerm(term) {
  return /^[\x20-\x7E]+$/.test(term) && /[A-Za-z0-9]/.test(term);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasLatinToken(text, token) {
  const pattern = new RegExp(
    `(?:^|[^A-Za-z0-9])${escapeRegExp(token)}(?=[^A-Za-z0-9]|$)`,
    'i',
  );
  return pattern.test(text);
}

function containsTerm(text, term) {
  if (isAsciiTerm(term)) {
    return hasLatinToken(text, term);
  }
  return text.toLowerCase().includes(term.toLowerCase());
}

function syllablesMatch(window, target) {
  return (
    window.length === target.length
    && window.every((item, index) => syllableSetsMatch(item, target[index]))
  );
}

function hasHomophone(transcript, term) {
  if (![...term].some((char) => /\p{Script=Han}/u.test(char))) {
    return false;
  }
  const target = hanSyllables(term);
  const source = hanSyllables(transcript);
  if (target.length === 0 || source.length < target.length) {
    return false;
  }

  for (let start = 0; start <= source.length - target.length; start += 1) {
    if (syllablesMatch(source.slice(start, start + target.length), target)) {
      return true;
    }
    const extraLength = target.length + 1;
    if (start + extraLength > source.length) {
      continue;
    }
    const window = source.slice(start, start + extraLength);
    for (let skip = 1; skip < window.length - 1; skip += 1) {
      const reduced = window.filter((_, index) => index !== skip);
      if (syllablesMatch(reduced, target)) {
        return true;
      }
    }
  }
  return false;
}

function sentenceCount(text) {
  return text
    .split(/[。！？]+/)
    .map((part) => part.trim())
    .filter(Boolean).length;
}

function normalizeIntro(text) {
  let value = String(text || '')
    .replace(/\u0000/g, '')
    .replace(/\r/g, '')
    .replace(/<\|im_end\|>/g, '')
    .trim();
  value = value.replace(/^简介[:：]\s*/, '').trim();
  const wrappers = [
    ['「', '」'],
    ['"', '"'],
    ['“', '”'],
  ];
  for (const [open, close] of wrappers) {
    if (
      value.startsWith(open) &&
      value.endsWith(close) &&
      countCharacters(value) > countCharacters(open) + countCharacters(close)
    ) {
      value = value.slice(open.length, value.length - close.length).trim();
      break;
    }
  }
  return value;
}

function sourceText(title, brandName, transcript) {
  return `${title}\n${brandName}\n${transcript}`;
}

function isSameBrand(candidate, brandName) {
  if (!candidate || !brandName) {
    return false;
  }
  return candidate === brandName || brandName.includes(candidate) || candidate.includes(brandName);
}

function acceptIntro({
  intro,
  title,
  brandName,
  transcript,
  terms,
  brandNames,
  placeholderIntro,
}) {
  const normalized = normalizeIntro(intro);
  const currentBrand = typeof brandName === 'string' ? brandName.trim() : '';
  const currentTitle = typeof title === 'string' ? title : '';
  const currentTranscript = typeof transcript === 'string' ? transcript : '';
  const source = sourceText(currentTitle, currentBrand, currentTranscript);
  const termList = Array.isArray(terms) ? terms : [];
  const brands = Array.isArray(brandNames) ? brandNames : [];

  const length = countCharacters(normalized);
  const sentences = sentenceCount(normalized);
  if (normalized === '' || length < MIN_INTRO_LENGTH || length > MAX_INTRO_LENGTH) {
    return { ok: false, intro: normalized, reason: `length ${length}` };
  }
  if (sentences < 1) {
    return { ok: false, intro: normalized, reason: `sentences ${sentences}` };
  }
  const banned = BANNED_PHRASES.find((phrase) => normalized.includes(phrase));
  if (banned) {
    return { ok: false, intro: normalized, reason: `banned ${banned}` };
  }
  if (placeholderIntro && normalized.includes(placeholderIntro)) {
    return { ok: false, intro: normalized, reason: 'placeholder' };
  }
  if (currentBrand === '' || !normalized.includes(currentBrand)) {
    return { ok: false, intro: normalized, reason: 'brand' };
  }
  const otherBrand = brands.find(
    (name) => !isSameBrand(name, currentBrand) && normalized.includes(name),
  );
  if (otherBrand) {
    return { ok: false, intro: normalized, reason: `other-brand ${otherBrand}` };
  }
  const formatToken = FORMAT_TOKENS.find(
    (token) => hasLatinToken(normalized, token) && !hasLatinToken(source, token),
  );
  if (formatToken) {
    return { ok: false, intro: normalized, reason: `format ${formatToken}` };
  }
  const capability = CAPABILITY_WORDS.find(
    (word) => normalized.includes(word) && !source.includes(word),
  );
  if (capability) {
    return { ok: false, intro: normalized, reason: `capability ${capability}` };
  }
  const ungroundedTerm = termList.find((term) => {
    if (typeof term !== 'string' || term.trim() === '') {
      return false;
    }
    const trimmed = term.trim();
    if (isAsciiTerm(trimmed) || !containsTerm(normalized, trimmed)) {
      return false;
    }
    if (containsTerm(source, trimmed)) {
      return false;
    }
    return !hasHomophone(currentTranscript, trimmed);
  });
  if (ungroundedTerm) {
    return { ok: false, intro: normalized, reason: `term ${String(ungroundedTerm).trim()}` };
  }
  return { ok: true, intro: normalized };
}

function joinTranscript(transcriptSegments) {
  if (!Array.isArray(transcriptSegments)) {
    return '';
  }
  return transcriptSegments
    .map((segment) => (segment && typeof segment.text === 'string' ? segment.text.trim() : ''))
    .filter(Boolean)
    .join('');
}

function buildIntroUserPrompt({ title, brandName, transcript, terms }) {
  const termList = Array.isArray(terms) ? terms.filter((term) => typeof term === 'string') : [];
  return [
    `标题：${title || ''}`,
    `品牌：${brandName || ''}`,
    `术语表：${termList.join('、')}`,
    `口播：${transcript || ''}`,
  ].join('\n');
}

module.exports = {
  BANNED_PHRASES,
  CAPABILITY_WORDS,
  FORMAT_TOKENS,
  INTRO_SYSTEM_PROMPT,
  MAX_INTRO_LENGTH,
  MIN_INTRO_LENGTH,
  acceptIntro,
  buildIntroUserPrompt,
  hasHomophone,
  joinTranscript,
  normalizeIntro,
};
