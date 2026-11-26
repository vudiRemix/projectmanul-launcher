'use strict';
// Проверяет, что приватный ключ в keys/ подходит к публичному ключу, вшитому в лаунчер.
//   npm run check-key
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const LEAKED = require('./leaked-keys');

const root = path.join(__dirname, '..');
const keyFile = path.join(root, 'keys', 'manifest-private.pem');
if (!fs.existsSync(keyFile)) {
  console.error(`Нет ключа: ${keyFile}\nПоложите файл manifest-private.pem в папку keys.`);
  process.exit(1);
}
const expected = JSON.parse(fs.readFileSync(path.join(root, 'launcher.config.json'), 'utf8')).publicKey;
const actual = crypto
  .createPublicKey(crypto.createPrivateKey(fs.readFileSync(keyFile)))
  .export({ type: 'spki', format: 'der' })
  .toString('base64');
if (LEAKED.includes(actual)) {
  console.error('Этот ключ засвечен (его пересылали открытым текстом). Создайте новый: npm run keygen -- --replace');
  process.exit(1);
}
if (actual === expected) {
  console.log('Ключ верный — лаунчеры примут сборки, подписанные им.');
} else {
  console.error('Ключ НЕ подходит к launcher.config.json. Сборки с ним лаунчеры отклонят.');
  process.exit(1);
}
