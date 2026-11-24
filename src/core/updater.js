'use strict';
// Самообновление: версия и хеш установщика берутся из подписанного манифеста.
const path = require('path');
const { spawn } = require('child_process');
const { downloadFile } = require('./http');

function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function needsUpdate(manifest, currentVersion) {
  return Boolean(manifest && manifest.launcher && compareVersions(manifest.launcher.version, currentVersion) > 0);
}

// Скачивает установщик, сверяет SHA-256 и запускает его в тихом режиме (NSIS /S).
async function downloadAndRunUpdate(manifest, tempDir, { onProgress, signal } = {}) {
  const l = manifest.launcher;
  const dest = path.join(tempDir, `launcher-setup-${l.version}.exe`);
  await downloadFile({ url: l.url, dest, size: l.size, hash: l.sha256, algo: 'sha256', onProgress, signal });
  const child = spawn(dest, ['/S', '--force-run'], { detached: true, stdio: 'ignore' });
  child.unref();
}

module.exports = { compareVersions, needsUpdate, downloadAndRunUpdate };
