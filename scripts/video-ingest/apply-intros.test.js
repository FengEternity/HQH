const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { applyIntros } = require('./apply-intros');

const SEGMENTS = [
  { startSec: 0, endSec: 4, text: '点击右下角的测量栏' },
  { startSec: 4, endSec: 8, text: '再点击左上角的点测量' },
];

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-apply-intros-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const manifestPath = path.join(directory, 'manifest.json');
  const reviewsPath = path.join(directory, 'intros.review.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      entries: [
        {
          sourceKey: 'a'.repeat(64),
          title: '南方点测量',
          intro: '演示南方点测量作业步骤。',
          introStatus: 'placeholder',
          transcriptSegments: SEGMENTS,
          transcription: { status: 'ready' },
        },
      ],
    }),
  );
  fs.chmodSync(manifestPath, 0o644);
  fs.writeFileSync(
    reviewsPath,
    JSON.stringify({
      reviews: [
        {
          sourceKey: 'a'.repeat(64),
          title: '南方点测量',
          intro: '点击右下角的测量栏。再点击左上角的点测量。',
        },
      ],
    }),
  );

  return { manifestPath, reviewsPath };
}

test('写回 manifest 后权限收紧为只对属主可读写', (t) => {
  const { manifestPath, reviewsPath } = fixture(t);

  const { plan } = applyIntros({ manifestPath, reviewsPath, dryRun: false });

  assert.equal(plan.appliedCount, 1);
  assert.equal(fs.statSync(manifestPath).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${manifestPath}.tmp`), false);

  const written = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(written.entries[0].introStatus, 'reviewed');
  assert.equal(written.entries[0].intro, '点击右下角的测量栏。再点击左上角的点测量。');
});

test('试运行不落盘也不改动权限', (t) => {
  const { manifestPath, reviewsPath } = fixture(t);

  const { plan } = applyIntros({ manifestPath, reviewsPath, dryRun: true });

  assert.equal(plan.appliedCount, 1);
  assert.equal(fs.statSync(manifestPath).mode & 0o777, 0o644);
  assert.equal(
    JSON.parse(fs.readFileSync(manifestPath, 'utf8')).entries[0].introStatus,
    'placeholder',
  );
});
