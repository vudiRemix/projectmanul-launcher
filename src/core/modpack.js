'use strict';
// Файлы сборки из манифеста и чистка лишнего в mods/.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { safeJoin } = require('./paths');

function planBuildFiles(paths, manifest) {
  return manifest.files.map((f) => ({
    url: f.url,
    dest: safeJoin(paths.gameDir, f.path),
    size: f.size,
    hash: f.sha256,
    algo: 'sha256',
    label: f.path,
    mode: f.mode || 'enforce',
    // Файлы сборки сверяются по хешу при каждом запуске (защита от подмены модов).
    alwaysHash: true,
  }));
}

// Файлы с режимом once (клиентские настройки) качаются, только если их нет.
function filterOnce(files) {
  return files.filter((f) => f.mode !== 'once' || !fs.existsSync(f.dest));
}

async function walk(dir, base, out) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = `${base}/${e.name}`;
    if (e.isDirectory()) await walk(abs, rel, out);
    else out.push({ abs, rel });
  }
  return out;
}

// Удаляет из cleanDirs (по умолчанию mods/) всё, чего нет в манифесте.
async function cleanManagedDirs(paths, manifest, log) {
  const expected = new Set(manifest.files.map((f) => f.path.toLowerCase()));
  const removed = [];
  for (const dir of manifest.cleanDirs) {
    const abs = safeJoin(paths.gameDir, dir);
    const files = await walk(abs, dir, []);
    for (const f of files) {
      if (expected.has(f.rel.toLowerCase())) continue;
      await fsp.rm(f.abs, { force: true });
      removed.push(f.rel);
      if (log) log(`[проверка] удалён лишний файл ${f.rel}`);
    }
    await removeEmptyDirs(abs, true);
  }
  return removed;
}

async function removeEmptyDirs(dir, keepRoot) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) if (e.isDirectory()) await removeEmptyDirs(path.join(dir, e.name), false);
  if (!keepRoot && (await fsp.readdir(dir)).length === 0) await fsp.rmdir(dir).catch(() => {});
}

module.exports = { planBuildFiles, filterOnce, cleanManagedDirs };
