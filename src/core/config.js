'use strict';
// Встроенный конфиг лаунчера: откуда брать манифест, новости и ключ подписи.
// Для разработки можно подменить файл переменной окружения MILSIM_CONFIG.
const fs = require('fs');
const path = require('path');

const REQUIRED = ['projectName', 'projectId', 'manifestUrl', 'remoteConfigUrl', 'newsUrl', 'publicKey'];

function loadLauncherConfig(appRoot) {
  const file = process.env.MILSIM_CONFIG || path.join(appRoot, 'launcher.config.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of REQUIRED) {
    if (typeof raw[key] !== 'string') throw new Error(`launcher.config.json: поле "${key}" должно быть строкой`);
  }
  if (!/^[a-z0-9_-]{1,32}$/.test(raw.projectId)) {
    throw new Error('launcher.config.json: projectId — только a-z, 0-9, _ и -');
  }
  const problems = [];
  if (!raw.publicKey) problems.push('publicKey пустой — запустите npm run keygen');
  for (const key of ['manifestUrl', 'remoteConfigUrl', 'newsUrl']) {
    if (raw[key].includes('OWNER/REPO')) problems.push(`${key} указывает на OWNER/REPO — впишите свой репозиторий`);
  }
  return { ...raw, configured: problems.length === 0, problems, file };
}

module.exports = { loadLauncherConfig };
