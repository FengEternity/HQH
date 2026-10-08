const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PLACEHOLDER_INTRO,
  draftIntroFromSegments,
  resolveAutoIntro,
} = require('./autoIntro');

const PLACEHOLDER = '讲解处理中，完成后请核对简介。';

test('builds a grounded step intro from transcript sentences', () => {
  const segments = [
    { startSec: 0, endSec: 2, text: '点击测量' },
    { startSec: 2, endSec: 4, text: '保存项目' },
  ];
  const out = resolveAutoIntro({
    transcriptSegments: segments,
    placeholderIntro: PLACEHOLDER,
  });
  assert.equal(out.grounded, true);
  assert.match(out.intro, /测量/);
});

test('ignores non-canonical 文本 field without text and returns placeholder', () => {
  const out = resolveAutoIntro({
    transcriptSegments: [{ startSec: 0, endSec: 2, 文本: '点击测量' }],
    placeholderIntro: PLACEHOLDER,
  });
  assert.equal(out.grounded, false);
  assert.equal(out.intro, PLACEHOLDER);
});

test('returns placeholder when there is no transcript', () => {
  const out = resolveAutoIntro({
    transcriptSegments: [],
    placeholderIntro: PLACEHOLDER,
  });
  assert.equal(out.grounded, false);
  assert.equal(out.intro, PLACEHOLDER);
});

test('truncates at sentence boundary under 400 characters and stays grounded', () => {
  const sentence = '点击右下角的测量栏进入点测量';
  const segments = Array.from({ length: 30 }, (_, index) => ({
    startSec: index * 2,
    endSec: index * 2 + 2,
    text: `${sentence}${index + 1}`,
  }));

  const draft = draftIntroFromSegments(segments);
  assert.ok(draft.length > 0);
  assert.ok([...draft].length <= 400);
  assert.match(draft, /[。！？；]$/, '截断应落在完整句末');

  const includedCount = (draft.match(/。/g) || []).length;
  const longerDraft = draftIntroFromSegments(
    segments.slice(0, includedCount + 1),
  );
  assert.ok([...longerDraft].length <= 400);
  if (includedCount < segments.length) {
    const withNext = draftIntroFromSegments(segments.slice(0, includedCount + 1));
    assert.ok(
      [...withNext].length > 400 || withNext === draft,
      '下一句若加入应超过 400 字或已被截断',
    );
  }

  const out = resolveAutoIntro({
    transcriptSegments: segments,
    placeholderIntro: PLACEHOLDER,
  });
  assert.equal(out.grounded, true);
  assert.ok([...out.intro].length <= 400);
});

test('exports PLACEHOLDER_INTRO matching catalog constant', () => {
  assert.equal(PLACEHOLDER_INTRO, PLACEHOLDER);
});

test('returns placeholder when segments have no usable text', () => {
  const out = resolveAutoIntro({
    transcriptSegments: [{ startSec: 0, endSec: 1, text: '   ' }],
    placeholderIntro: PLACEHOLDER,
  });
  assert.equal(out.grounded, false);
  assert.equal(out.intro, PLACEHOLDER);
});
