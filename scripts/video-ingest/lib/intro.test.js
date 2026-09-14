const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildIntroPlan,
  normalizeIntro,
  validateReviewedIntro,
} = require('./intro');

const SEGMENTS = [
  { startSec: 1.2, endSec: 4, text: '当仪器连接后' },
  { startSec: 4, endSec: 7.5, text: '点击右下角的测量栏' },
  { startSec: 7.5, endSec: 11, text: '点击左上角的点测量' },
  { startSec: 11, endSec: 16, text: '查看手簿上方信息栏是否达到固定解状态' },
];

const PLACEHOLDER = '演示南方点测量作业步骤。';

function issueCodes(result) {
  return result.issues.map((issue) => issue.code);
}

test('空白介绍被拒绝', () => {
  const result = validateReviewedIntro({
    intro: '   \n ',
    transcriptSegments: SEGMENTS,
    placeholderIntro: PLACEHOLDER,
  });

  assert.equal(result.valid, false);
  assert.deepEqual(issueCodes(result), ['EMPTY']);
});

test('正好 400 字通过，401 字被拒绝', () => {
  const grounded = '点击右下角的测量栏进入点测量。';
  const filler = '气'.repeat(400 - grounded.length);
  const maximum = `${grounded}${filler}`;

  const accepted = validateReviewedIntro({
    intro: maximum,
    transcriptSegments: SEGMENTS,
    placeholderIntro: PLACEHOLDER,
  });
  assert.equal(accepted.valid, true);
  assert.equal(accepted.length, 400);

  const rejected = validateReviewedIntro({
    intro: `${maximum}气`,
    transcriptSegments: SEGMENTS,
    placeholderIntro: PLACEHOLDER,
  });
  assert.equal(rejected.valid, false);
  assert.deepEqual(issueCodes(rejected), ['TOO_LONG']);
  assert.equal(rejected.length, 401);
});

test('仍等于 A1 占位句时被拒绝', () => {
  const result = validateReviewedIntro({
    intro: ` ${PLACEHOLDER} `,
    transcriptSegments: SEGMENTS,
    placeholderIntro: PLACEHOLDER,
  });

  assert.equal(result.valid, false);
  assert.deepEqual(issueCodes(result), ['PLACEHOLDER']);
});

test('完全脱离字幕的介绍被拒绝', () => {
  const result = validateReviewedIntro({
    intro: '打开电脑浏览器登录官网下载驱动安装包并解压。',
    transcriptSegments: SEGMENTS,
    placeholderIntro: PLACEHOLDER,
  });

  assert.equal(result.valid, false);
  assert.deepEqual(issueCodes(result), ['NOT_GROUNDED']);
});

test('五十字的真实两步说明通过，不按最小字数拒绝', () => {
  const intro =
    '仪器连接后点击右下角的测量栏，再点击点测量；等待固定解并让气泡居中后按测量键采集。';
  const result = validateReviewedIntro({
    intro,
    transcriptSegments: SEGMENTS,
    placeholderIntro: PLACEHOLDER,
  });

  assert.equal(result.valid, true);
  assert.ok(result.length < 60);
});

test('英文数字型号只要出现在字幕里也算有据可依', () => {
  const result = validateReviewedIntro({
    intro: '把 C10 手簿连上仪器后开始升级。',
    transcriptSegments: [{ startSec: 0, endSec: 3, text: '本次使用 C10 手簿演示' }],
    placeholderIntro: '演示南方 C10 手簿软件升级。',
  });

  assert.equal(result.valid, true);
});

test('纯数字巧合不构成字幕依据', () => {
  const result = validateReviewedIntro({
    intro: '大约第 12 秒进入参数设置面板确认基准。',
    transcriptSegments: [{ startSec: 0, endSec: 3, text: '偏差是 12 厘米' }],
    placeholderIntro: PLACEHOLDER,
  });

  assert.equal(result.valid, false);
  assert.deepEqual(issueCodes(result), ['NOT_GROUNDED']);
});

test('字幕为空时无法生成审核介绍', () => {
  const result = validateReviewedIntro({
    intro: '点击右下角的测量栏进入点测量。',
    transcriptSegments: [],
    placeholderIntro: PLACEHOLDER,
  });

  assert.equal(result.valid, false);
  assert.deepEqual(issueCodes(result), ['NO_TRANSCRIPT']);
});

test('规范化只清理首尾空白并合并内部空白', () => {
  assert.equal(
    normalizeIntro('  打开 C10 手簿。\n  点击升级。 '),
    '打开 C10 手簿。 点击升级。',
  );
});

const CONTENT = {
  南方点测量: { intro: PLACEHOLDER, tags: ['点测量'], modelName: '' },
  南方数据导出: { intro: '演示南方手簿数据导出。', tags: ['导出'], modelName: '' },
};

function readyEntry() {
  return {
    sourceKey: 'a'.repeat(64),
    title: '南方点测量',
    intro: PLACEHOLDER,
    transcriptSegments: SEGMENTS,
    transcription: { status: 'ready' },
  };
}

function skippedEntry() {
  return {
    sourceKey: 'b'.repeat(64),
    title: '南方数据导出',
    intro: '演示南方手簿数据导出。',
    transcriptSegments: [],
    transcription: { status: 'skipped' },
  };
}

function reviewedEntry(overrides = {}) {
  return {
    sourceKey: 'a'.repeat(64),
    title: '南方点测量',
    intro: '点击右下角的测量栏，再点击点测量。',
    introStatus: 'reviewed',
    transcriptSegments: SEGMENTS,
    transcription: { status: 'ready' },
    ...overrides,
  };
}

test('合格介绍写入 intro 并标记 reviewed', () => {
  const entries = [readyEntry(), skippedEntry()];
  const plan = buildIntroPlan({
    entries,
    reviews: [
      {
        sourceKey: 'a'.repeat(64),
        title: '南方点测量',
        intro: ' 点击右下角的测量栏，再点击点测量。 ',
      },
    ],
    content: CONTENT,
  });

  assert.equal(plan.appliedCount, 1);
  assert.equal(plan.entries[0].intro, '点击右下角的测量栏，再点击点测量。');
  assert.equal(plan.entries[0].introStatus, 'reviewed');
  assert.equal(entries[0].introStatus, undefined);
  assert.equal(plan.entries[1].intro, '演示南方手簿数据导出。');
  assert.equal(plan.entries[1].introStatus, 'placeholder');
});

test('审核稿缺少 title 时直接拒绝，不靠 sourceKey 单独放行', () => {
  const plan = buildIntroPlan({
    entries: [readyEntry()],
    reviews: [
      {
        sourceKey: 'a'.repeat(64),
        intro: '点击右下角的测量栏，再点击点测量。',
      },
    ],
    content: CONTENT,
  });

  assert.equal(plan.appliedCount, 0);
  assert.equal(plan.rejectedCount, 1);
  assert.deepEqual(
    plan.results[0].issues.map((item) => item.code),
    ['TITLE_REQUIRED'],
  );
  assert.equal(plan.entries[0].intro, PLACEHOLDER);
  assert.equal(plan.entries[0].introStatus, 'placeholder');
});

test('原本 reviewed 的条目字幕退回非 ready 时降级为 needs_review', () => {
  const plan = buildIntroPlan({
    entries: [
      reviewedEntry({ transcription: { status: 'skipped' }, transcriptSegments: [] }),
    ],
    reviews: [
      {
        sourceKey: 'a'.repeat(64),
        title: '南方点测量',
        intro: '点击右下角的测量栏，再点击点测量。',
      },
    ],
    content: CONTENT,
  });

  assert.equal(plan.rejectedCount, 1);
  assert.deepEqual(
    plan.results[0].issues.map((item) => item.code),
    ['NOT_READY'],
  );
  assert.equal(plan.entries[0].introStatus, 'needs_review');
});

test('原本 reviewed 的条目新稿校验失败时降级为 needs_review', () => {
  const plan = buildIntroPlan({
    entries: [reviewedEntry()],
    reviews: [
      {
        sourceKey: 'a'.repeat(64),
        title: '南方点测量',
        intro: '打开电脑浏览器登录官网下载驱动安装包并解压。',
      },
    ],
    content: CONTENT,
  });

  assert.equal(plan.rejectedCount, 1);
  assert.equal(plan.entries[0].introStatus, 'needs_review');
  assert.equal(plan.entries[0].intro, '点击右下角的测量栏，再点击点测量。');
});

test('未提交审核稿但字幕已退回非 ready 时旧 reviewed 也要降级', () => {
  const plan = buildIntroPlan({
    entries: [
      reviewedEntry({ transcription: { status: 'failed' }, transcriptSegments: [] }),
    ],
    reviews: [],
    content: CONTENT,
  });

  assert.equal(plan.entries[0].introStatus, 'needs_review');
  assert.deepEqual(
    plan.results[0].issues.map((item) => item.code),
    ['NOT_READY'],
  );
});

test('未提交审核稿且旧 intro 已脱离新字幕时降级为 needs_review', () => {
  const plan = buildIntroPlan({
    entries: [reviewedEntry({ intro: '打开电脑浏览器登录官网下载驱动安装包并解压。' })],
    reviews: [],
    content: CONTENT,
  });

  assert.equal(plan.entries[0].introStatus, 'needs_review');
  assert.deepEqual(
    plan.results[0].issues.map((item) => item.code),
    ['NOT_GROUNDED'],
  );
});

test('降级后连续第二次运行仍保持 needs_review 且继续计入 rejected', () => {
  const first = buildIntroPlan({
    entries: [
      reviewedEntry({ transcription: { status: 'skipped' }, transcriptSegments: [] }),
    ],
    reviews: [
      {
        sourceKey: 'a'.repeat(64),
        title: '南方点测量',
        intro: '点击右下角的测量栏，再点击点测量。',
      },
    ],
    content: CONTENT,
  });
  assert.equal(first.entries[0].introStatus, 'needs_review');

  const second = buildIntroPlan({
    entries: first.entries,
    reviews: [],
    content: CONTENT,
  });

  assert.equal(second.entries[0].introStatus, 'needs_review');
  assert.equal(second.rejectedCount, 1);
  assert.equal(second.skippedCount, 0);
  assert.equal(second.entries[0].intro, '点击右下角的测量栏，再点击点测量。');

  const third = buildIntroPlan({ entries: second.entries, reviews: [], content: CONTENT });
  assert.equal(third.entries[0].introStatus, 'needs_review');
  assert.equal(third.rejectedCount, 1);
});

test('needs_review 且仍不匹配当前字幕时不会退回 placeholder', () => {
  const plan = buildIntroPlan({
    entries: [
      reviewedEntry({
        introStatus: 'needs_review',
        intro: '打开电脑浏览器登录官网下载驱动安装包并解压。',
      }),
    ],
    reviews: [],
    content: CONTENT,
  });

  assert.equal(plan.entries[0].introStatus, 'needs_review');
  assert.equal(plan.rejectedCount, 1);
  assert.deepEqual(
    plan.results[0].issues.map((item) => item.code),
    ['NOT_GROUNDED'],
  );
});

test('needs_review 没有新审核稿时不因旧 intro 能过校验就自动恢复 reviewed', () => {
  const plan = buildIntroPlan({
    entries: [reviewedEntry({ introStatus: 'needs_review' })],
    reviews: [],
    content: CONTENT,
  });

  assert.equal(plan.appliedCount, 0);
  assert.equal(plan.rejectedCount, 1);
  assert.equal(plan.entries[0].introStatus, 'needs_review');
  assert.deepEqual(
    plan.results[0].issues.map((item) => item.code),
    ['NEEDS_NEW_REVIEW'],
  );
});

test('needs_review 收到合格新审核稿后恢复 reviewed', () => {
  const plan = buildIntroPlan({
    entries: [reviewedEntry({ introStatus: 'needs_review', intro: PLACEHOLDER })],
    reviews: [
      {
        sourceKey: 'a'.repeat(64),
        title: '南方点测量',
        intro: '点击右下角的测量栏，再点击点测量完成采集。',
      },
    ],
    content: CONTENT,
  });

  assert.equal(plan.appliedCount, 1);
  assert.equal(plan.rejectedCount, 0);
  assert.equal(plan.entries[0].introStatus, 'reviewed');
  assert.equal(plan.entries[0].intro, '点击右下角的测量栏，再点击点测量完成采集。');
});

test('未提交审核稿但旧 intro 仍能通过校验时保持 reviewed', () => {
  const plan = buildIntroPlan({
    entries: [reviewedEntry()],
    reviews: [],
    content: CONTENT,
  });

  assert.equal(plan.appliedCount, 0);
  assert.equal(plan.rejectedCount, 0);
  assert.equal(plan.skippedCount, 1);
  assert.equal(plan.entries[0].introStatus, 'reviewed');
  assert.equal(plan.entries[0].intro, '点击右下角的测量栏，再点击点测量。');
});

test('校验失败的条目保留 A1 占位 intro', () => {
  const plan = buildIntroPlan({
    entries: [readyEntry()],
    reviews: [
      {
        sourceKey: 'a'.repeat(64),
        title: '南方点测量',
        intro: '打开电脑浏览器登录官网下载驱动安装包并解压。',
      },
    ],
    content: CONTENT,
  });

  assert.equal(plan.appliedCount, 0);
  assert.equal(plan.rejectedCount, 1);
  assert.equal(plan.entries[0].intro, PLACEHOLDER);
  assert.equal(plan.entries[0].introStatus, 'placeholder');
  assert.deepEqual(
    plan.results[0].issues.map((issue) => issue.code),
    ['NOT_GROUNDED'],
  );
});

test('字幕未 ready 的条目即使提交审核稿也不覆盖', () => {
  const plan = buildIntroPlan({
    entries: [skippedEntry()],
    reviews: [
      {
        sourceKey: 'b'.repeat(64),
        title: '南方数据导出',
        intro: '点击右下角的测量栏，再点击点测量。',
      },
    ],
    content: CONTENT,
  });

  assert.equal(plan.appliedCount, 0);
  assert.equal(plan.rejectedCount, 1);
  assert.deepEqual(
    plan.results[0].issues.map((issue) => issue.code),
    ['NOT_READY'],
  );
  assert.equal(plan.entries[0].intro, '演示南方手簿数据导出。');
});

test('标题与 sourceKey 不匹配时拒绝，避免串条目', () => {
  const plan = buildIntroPlan({
    entries: [readyEntry()],
    reviews: [
      {
        sourceKey: 'a'.repeat(64),
        title: '南方数据导出',
        intro: '点击右下角的测量栏，再点击点测量。',
      },
    ],
    content: CONTENT,
  });

  assert.equal(plan.rejectedCount, 1);
  assert.deepEqual(
    plan.results[0].issues.map((issue) => issue.code),
    ['TITLE_MISMATCH'],
  );
  assert.equal(plan.entries[0].intro, PLACEHOLDER);
});

test('未提交审核稿的条目记为跳过且不报错', () => {
  const plan = buildIntroPlan({
    entries: [readyEntry()],
    reviews: [],
    content: CONTENT,
  });

  assert.equal(plan.skippedCount, 1);
  assert.equal(plan.entries[0].intro, PLACEHOLDER);
  assert.deepEqual(plan.unknownSourceKeys, []);
});

test('review 文件里的未知 sourceKey 被单独报出', () => {
  const plan = buildIntroPlan({
    entries: [readyEntry()],
    reviews: [{ sourceKey: 'c'.repeat(64), title: '别的片子', intro: '点击测量栏。' }],
    content: CONTENT,
  });

  assert.deepEqual(plan.unknownSourceKeys, ['c'.repeat(64)]);
  assert.equal(plan.appliedCount, 0);
});

test('review 文件重复 sourceKey 直接失败', () => {
  assert.throws(
    () =>
      buildIntroPlan({
        entries: [readyEntry()],
        reviews: [
          { sourceKey: 'a'.repeat(64), title: '南方点测量', intro: '点击测量栏进入点测量。' },
          { sourceKey: 'a'.repeat(64), title: '南方点测量', intro: '点击测量栏再点点测量。' },
        ],
        content: CONTENT,
      }),
    /重复/,
  );
});

test('重复应用同一份审核稿结果稳定', () => {
  const reviews = [
    {
      sourceKey: 'a'.repeat(64),
      title: '南方点测量',
      intro: '点击右下角的测量栏，再点击点测量。',
    },
  ];
  const first = buildIntroPlan({ entries: [readyEntry()], reviews, content: CONTENT });
  const second = buildIntroPlan({ entries: first.entries, reviews, content: CONTENT });

  assert.equal(second.appliedCount, 1);
  assert.deepEqual(second.entries, first.entries);
});
