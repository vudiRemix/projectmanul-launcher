'use strict';
const crypto = require('crypto');
const fs = require('fs');

function hashFile(file, algo = 'sha256') {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    const s = fs.createReadStream(file);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

// quick = true: только наличие и размер (быстрая проверка перед каждым запуском).
async function fileMatches(file, { size, hash, algo = 'sha256', quick = false } = {}) {
  let st;
  try {
    st = await fs.promises.stat(file);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  if (size != null && st.size !== size) return false;
  if (quick || !hash) return true;
  return (await hashFile(file, algo)) === hash.toLowerCase();
}

module.exports = { hashFile, fileMatches };
