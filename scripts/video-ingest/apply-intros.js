#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { writeJsonAtomic } = require('./lib/atomicJson');
const { buildIntroPlan } = require('./lib/intro');
const content = require('./content.zh-CN.json');

const USAGE =
  '用法：apply-intros.js --manifest <manifest.json> --reviews <intros.review.json> [--dry-run]';

function parseArguments(argv) {
  const values = { dryRun: false };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--dry-run') {
      values.dryRun = true;
      continue;
    }
    const value = argv[index + 1];
    if (!['--manifest', '--reviews'].includes(flag) || !value) {
      throw new Error(USAGE);
    }
    values[flag] = value;
    index += 1;
  }

  if (!values['--manifest'] || !values['--reviews']) {
    throw new Error(USAGE);
  }

  return {
    manifestPath: values['--manifest'],
    reviewsPath: values['--reviews'],
    dryRun: values.dryRun,
  };
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`读取 ${path.basename(filePath)} 失败：${error.message}`);
  }
}

function readReviews(filePath) {
  const payload = readJson(filePath);
  if (!payload || !Array.isArray(payload.reviews)) {
    throw new Error('审核文件需要形如 { "reviews": [{ "sourceKey": …, "title": …, "intro": … }] }');
  }
  return payload.reviews;
}

function describeResult(result) {
  const codes = result.issues.map((item) => item.code).join(',');
  const detail = result.action === 'applied' ? `${result.length} 字` : codes;
  return `${result.action}\t${result.title}\t${detail}`;
}

function applyIntros({ manifestPath, reviewsPath, dryRun }) {
  const manifest = readJson(manifestPath);
  if (!manifest || !Array.isArray(manifest.entries)) {
    throw new Error('manifest 缺少 entries');
  }

  const plan = buildIntroPlan({
    entries: manifest.entries,
    reviews: readReviews(reviewsPath),
    content,
  });

  const lines = plan.results.map(describeResult);
  for (const sourceKey of plan.unknownSourceKeys) {
    lines.push(`unknown\t${sourceKey}\t不在 manifest 中`);
  }

  if (!dryRun) {
    writeJsonAtomic(manifestPath, { ...manifest, entries: plan.entries });
  }

  return { plan, lines };
}

if (require.main === module) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const { plan, lines } = applyIntros(options);
    process.stdout.write(`${lines.join('\n')}\n`);
    process.stdout.write(
      `${options.dryRun ? '试运行' : '已写入'}：reviewed ${plan.appliedCount} 条，` +
        `拒绝 ${plan.rejectedCount} 条，跳过 ${plan.skippedCount} 条，` +
        `未知 ${plan.unknownSourceKeys.length} 条\n`,
    );
    if (plan.rejectedCount > 0 || plan.unknownSourceKeys.length > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  applyIntros,
  parseArguments,
};
