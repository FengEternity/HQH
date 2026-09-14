const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { MANIFEST_FILE_MODE, writeJsonAtomic } = require('./atomicJson');

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hqh-atomic-json-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('新写入的 manifest 只对属主可读写', (t) => {
  const target = path.join(tempDirectory(t), 'manifest.json');

  writeJsonAtomic(target, { version: 1, entries: [] });

  assert.equal(fs.statSync(target).mode & 0o777, MANIFEST_FILE_MODE);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { version: 1, entries: [] });
});

test('覆盖写入后权限收紧，不继承旧文件或残留临时文件的宽松权限', (t) => {
  const directory = tempDirectory(t);
  const target = path.join(directory, 'manifest.json');
  fs.writeFileSync(target, '{}');
  fs.chmodSync(target, 0o644);
  fs.writeFileSync(`${target}.tmp`, 'stale');
  fs.chmodSync(`${target}.tmp`, 0o666);

  writeJsonAtomic(target, { version: 2, entries: [] });

  assert.equal(fs.statSync(target).mode & 0o777, MANIFEST_FILE_MODE);
  assert.equal(fs.existsSync(`${target}.tmp`), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { version: 2, entries: [] });
});
