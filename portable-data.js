const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function resolveDataDirectory({ packaged, platform, executable, projectRoot, portableDirectory }) {
  const root = !packaged ? projectRoot : platform === 'darwin'
    ? path.resolve(path.dirname(executable), '../../..')
    : portableDirectory || path.dirname(executable);
  return path.join(root, 'data');
}

function initializePortableDatabase(directory, legacyFile, seedFile) {
  fs.mkdirSync(directory, { recursive: true });
  fs.accessSync(directory, fs.constants.W_OK);
  const target = path.join(directory, 'valuation.sqlite');
  if (fs.existsSync(target)) return target;
  const temporary = path.join(directory, 'initializing-' + process.pid + '.sqlite');
  try {
    if (fs.existsSync(legacyFile)) {
      // SQLite's snapshot includes committed WAL data, unlike copying only the DB file.
      const source = new DatabaseSync(legacyFile, { readOnly: true });
      try { source.exec("VACUUM INTO '" + temporary.replaceAll("'", "''") + "'"); }
      finally { source.close(); }
    } else if (fs.existsSync(seedFile)) {
      fs.copyFileSync(seedFile, temporary, fs.constants.COPYFILE_EXCL);
    } else {
      throw new Error('安装包缺少初始数据库');
    }
    fs.renameSync(temporary, target);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
  return target;
}

module.exports = { resolveDataDirectory, initializePortableDatabase };
