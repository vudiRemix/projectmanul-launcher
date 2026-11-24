'use strict';
const path = require('path');

// Все файлы игры лежат в одной папке (по умолчанию %APPDATA%\.<projectId>),
// как у обычного .minecraft: mods/, config/, saves/ рядом с libraries/ и assets/.
function createPaths(rootDir) {
  const internal = path.join(rootDir, '.launcher');
  return {
    root: rootDir,
    gameDir: rootDir,
    runtime: path.join(rootDir, 'runtime'),
    libraries: path.join(rootDir, 'libraries'),
    assets: path.join(rootDir, 'assets'),
    versions: path.join(rootDir, 'versions'),
    natives: path.join(rootDir, 'natives'),
    logs: path.join(rootDir, 'logs'),
    crashReports: path.join(rootDir, 'crash-reports'),
    internal,
    temp: path.join(internal, 'tmp'),
    manifestCache: path.join(internal, 'manifest.json'),
  };
}

// Склеивает путь из манифеста с папкой игры и не даёт выйти за её пределы.
function safeJoin(base, relPosix) {
  if (typeof relPosix !== 'string' || relPosix.length === 0) throw new Error('Пустой путь в манифесте');
  if (relPosix.includes('\\') || relPosix.startsWith('/') || /^[a-zA-Z]:/.test(relPosix)) {
    throw new Error(`Недопустимый путь в манифесте: ${relPosix}`);
  }
  const parts = relPosix.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new Error(`Недопустимый путь в манифесте: ${relPosix}`);
  }
  const full = path.resolve(base, ...parts);
  const root = path.resolve(base) + path.sep;
  if (!full.startsWith(root)) throw new Error(`Путь выходит за папку игры: ${relPosix}`);
  return full;
}

module.exports = { createPaths, safeJoin };
