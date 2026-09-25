const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'cards.json');

function ensureDB() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, '{}', 'utf8');
}

function readDB() {
  ensureDB();
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    // 壊れたデータは空として扱う（本番では別途バックアップ運用を推奨）
    return {};
  }
}

function writeDB(db) {
  ensureDB();
  // 書き込み中のクラッシュでデータが壊れないよう、一時ファイル経由でatomicに置き換える
  const tmpPath = DB_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmpPath, DB_PATH);
}

module.exports = { readDB, writeDB };
