'use strict';
// Создаёт пару ключей Ed25519 для подписи манифеста.
//   node tools/keygen.js [путь к приватному ключу]
// Приватный ключ остаётся только у администратора (НЕ коммитить!),
// публичный вписывается в launcher.config.json → "publicKey".
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'keys', 'manifest-private.pem'));
if (fs.existsSync(out)) {
  console.error(`Ключ уже есть: ${out}\nЕсли заменить его, старые версии лаунчера перестанут принимать сборки. Удалите файл вручную, если это точно нужно.`);
  process.exit(1);
}
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
console.log(`Приватный ключ: ${out}  — храните в секрете, не выкладывайте на GitHub.`);
console.log('\nПубличный ключ — вставьте в launcher.config.json в поле "publicKey":\n');
console.log(pub);
