const { validateReviewedIntro } = require('./intro');

const PLACEHOLDER_INTRO = '讲解处理中，完成后请核对简介。';
const MAX_INTRO_LENGTH = 400;
const SENTENCE_SPLIT_PATTERN = /[。！？；]+/;

function countCharacters(text) {
  return [...text].length;
}

function getSegmentText(segment) {
  if (!segment || typeof segment !== 'object') {
    return '';
  }
  if (typeof segment.text !== 'string') {
    return '';
  }
  return segment.text.trim();
}

function collectSentences(transcriptSegments) {
  const sentences = [];
  if (!Array.isArray(transcriptSegments)) {
    return sentences;
  }

  for (const segment of transcriptSegments) {
    const raw = getSegmentText(segment);
    if (raw === '') {
      continue;
    }
    const parts = raw
      .split(SENTENCE_SPLIT_PATTERN)
      .map((part) => part.trim())
      .filter(Boolean);
    sentences.push(...parts);
  }

  return sentences;
}

function draftIntroFromSegments(transcriptSegments) {
  const sentences = collectSentences(transcriptSegments);
  if (sentences.length === 0) {
    return '';
  }

  let draft = '';
  for (const sentence of sentences) {
    const next = draft === '' ? `${sentence}。` : `${draft}${sentence}。`;
    if (countCharacters(next) > MAX_INTRO_LENGTH) {
      break;
    }
    draft = next;
  }

  return draft;
}

function resolveAutoIntro({ transcriptSegments, placeholderIntro }) {
  const draft = draftIntroFromSegments(transcriptSegments);
  if (draft === '') {
    return { intro: placeholderIntro, grounded: false };
  }

  const validation = validateReviewedIntro({
    intro: draft,
    transcriptSegments,
    placeholderIntro,
    keyframeEvidence: [],
  });

  if (validation.valid) {
    return { intro: validation.intro, grounded: true };
  }

  return { intro: placeholderIntro, grounded: false };
}

module.exports = {
  PLACEHOLDER_INTRO,
  draftIntroFromSegments,
  resolveAutoIntro,
};
