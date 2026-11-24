'use strict';
// Встроенная Java из официального индекса Mojang (тот же, что у ванильного лаунчера).
// Каждый файл качается отдельно и сверяется по SHA-1, системная Java не используется.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { fetchJson } = require('./http');

const RUNTIME_INDEX =
  'https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

function platformKey() {
  if (process.platform === 'win32') {
    return { x64: 'windows-x64', arm64: 'windows-arm64', ia32: 'windows-x86' }[process.arch] || 'windows-x64';
  }
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  return process.arch === 'ia32' ? 'linux-i386' : 'linux';
}

function javaExecutables(home) {
  if (process.platform === 'win32') {
    return { java: path.join(home, 'bin', 'java.exe'), javaw: path.join(home, 'bin', 'javaw.exe') };
  }
  const java = path.join(home, process.platform === 'darwin' ? 'jre.bundle/Contents/Home/bin/java' : 'bin/java');
  return { java, javaw: java };
}

// Возвращает список файлов для syncFiles и пути к java/javaw.
async function planJava(paths, component, { signal } = {}) {
  const home = path.join(paths.runtime, component);
  const stateFile = path.join(paths.runtime, `${component}.state.json`);
  let manifest;
  try {
    const index = await fetchJson(RUNTIME_INDEX, { signal });
    const entries = (index[platformKey()] || {})[component];
    if (!entries || entries.length === 0) throw new Error(`Mojang не публикует ${component} для ${platformKey()}`);
    manifest = await fetchJson(entries[0].manifest.url, { signal });
    await fsp.mkdir(paths.runtime, { recursive: true });
    await fsp.writeFile(stateFile, JSON.stringify({ version: entries[0].version, manifest }));
  } catch (err) {
    // Без сети используем уже установленную Java, если она есть.
    try {
      manifest = JSON.parse(await fsp.readFile(stateFile, 'utf8')).manifest;
    } catch {
      throw err;
    }
  }

  const files = [];
  for (const [rel, info] of Object.entries(manifest.files)) {
    const dest = path.join(home, ...rel.split('/'));
    if (info.type === 'directory') {
      await fsp.mkdir(dest, { recursive: true });
    } else if (info.type === 'file' && info.downloads && info.downloads.raw) {
      const raw = info.downloads.raw;
      files.push({ url: raw.url, dest, size: raw.size, hash: raw.sha1, algo: 'sha1', label: rel, executable: info.executable });
    }
  }
  return { home, files, ...javaExecutables(home) };
}

async function fixPermissions(files) {
  if (process.platform === 'win32') return;
  for (const f of files) if (f.executable) await fsp.chmod(f.dest, 0o755).catch(() => {});
}

module.exports = { planJava, fixPermissions };
