'use strict';
// Создаёт пару ключей Ed25519 для подписи манифеста и сразу вписывает публичную половину
// в launcher.config.json → "publicKey".
//   npm run keygen                  — создать ключ, если его ещё нет
//   npm run keygen -- --replace     — заменить существующий (старый переименуется в *.old-<время>.pem)
// Приватный ключ остаётся только у администратора (НЕ коммитить!).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const replace = process.argv.includes('--replace');
// Свой путь (node tools/keygen.js <файл>) — для тестов: ключ пишется туда, launcher.config.json
// не трогается, последней строкой печатается публичный ключ.
const custom = process.argv.slice(2).find((a) => !a.startsWith('--'));
const out = custom ? path.resolve(custom) : path.join(root, 'keys', 'manifest-private.pem');
const configFile = path.join(root, 'launcher.config.json');

if (fs.existsSync(out)) {
  if (!replace) {
    console.error(
      `Ключ уже есть: ${out}\n` +
        'Заменить: npm run keygen -- --replace\n' +
        'После замены уже установленные лаунчеры перестанут принимать новые сборки — их придётся переустановить.\n' +
        'Пока не было ни одного выпуска, менять ключ безопасно.',
    );
    process.exit(1);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = out.replace(/\.pem$/, `.old-${stamp}.pem`);
  fs.renameSync(out, backup);
  console.log(`Старый ключ переименован: ${backup}`);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
if (custom) {
  console.log(`Приватный ключ: ${out}\nПубличный ключ:\n${pub}`);
  process.exit(0);
}

const text = fs.readFileSync(configFile, 'utf8');
const updated = text.replace(/("publicKey"\s*:\s*")[^"]*(")/, `$1${pub}$2`);
if (updated === text && !text.includes(pub)) {
  console.error(`Не нашёл поле "publicKey" в ${configFile}. Впишите вручную:\n${pub}`);
  process.exit(1);
}
fs.writeFileSync(configFile, updated);

console.log(`Приватный ключ: ${out}`);
console.log('  храните в секрете: не выкладывайте на GitHub, не пересылайте в чатах, сделайте копию на флешку.');
console.log(`Публичный ключ вписан в launcher.config.json:\n  ${pub}`);
console.log('\nДальше: соберите установщик заново (npm run dist) и закоммитьте launcher.config.json.');
