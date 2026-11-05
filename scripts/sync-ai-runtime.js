'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'shared/ai-runtime/index.js'), 'utf8');
const targets = ['cloudfunctions/agent/lib/ai-runtime.js', 'scripts/video-ingest/lib/ai-runtime.js'];
const check = process.argv.includes('--check');
let failed = false;
for (const target of targets) {
  const file = path.join(root, target);
  const expected = '// 自动同步自 shared/ai-runtime/index.js，请通过 scripts/sync-ai-runtime.js 更新。\n' + source;
  if (check) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== expected) {
      process.stderr.write('模型调用发布副本不同步：' + target + '\n');
      failed = true;
    }
  } else {
    fs.writeFileSync(file, expected);
  }
}
if (failed) process.exitCode = 1;
