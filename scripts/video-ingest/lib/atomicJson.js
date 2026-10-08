const fs = require('node:fs');

// manifest 里有字幕全文与云端 fileId，属于本机运营数据，不给同机其它用户读。
const MANIFEST_FILE_MODE = 0o600;

function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp`;
  // writeFileSync 的 mode 只在创建时生效，残留的旧临时文件会沿用宽松权限。
  fs.rmSync(temporaryPath, { force: true });
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: MANIFEST_FILE_MODE,
  });
  fs.chmodSync(temporaryPath, MANIFEST_FILE_MODE);
  fs.renameSync(temporaryPath, filePath);
}

module.exports = {
  MANIFEST_FILE_MODE,
  writeJsonAtomic,
};
