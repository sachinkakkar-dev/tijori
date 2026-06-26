// Encrypted-at-rest store. The whole DB is one file, AES-256-GCM encrypted
// with a key derived from SERVER_ENC_KEY. Nothing readable ever hits disk.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'db.enc');
const KEY = crypto.createHash('sha256')
  .update(process.env.SERVER_ENC_KEY || 'CHANGE_ME_dev_only')
  .digest(); // 32 bytes

function load() {
  try {
    if (!fs.existsSync(FILE)) return { families: {}, objects: {} };
    const raw = fs.readFileSync(FILE);
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    d.setAuthTag(tag);
    const pt = Buffer.concat([d.update(ct), d.final()]);
    const db = JSON.parse(pt.toString('utf8'));
    db.families = db.families || {};
    db.objects = db.objects || {};
    return db;
  } catch (e) {
    console.error('store.load failed (bad key or corrupt file):', e.message);
    throw e;
  }
}

function save(db) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(db), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, Buffer.concat([iv, tag, ct]));
  fs.renameSync(tmp, FILE); // atomic-ish write
}

module.exports = { load, save };
