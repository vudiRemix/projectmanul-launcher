'use strict';
// Forge ставится официальным установщиком в режиме без окна (--installClient):
// он сам качает библиотеки с серверов Forge/Mojang и собирает пропатченный клиент.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { fetchText, downloadFile } = require('./http');
const { mavenPath } = require('./rules');
const { libraryFiles, readJson } = require('./minecraft');

const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';

function forgeVersionId(mc, forge) {
  return `${mc}-forge-${forge}`;
}

function forgeJsonPath(paths, id) {
  return path.join(paths.versions, id, `${id}.json`);
}

// Установлен ли Forge: есть version.json и все его библиотеки (включая собранные установщиком).
async function isForgeInstalled(paths, id) {
  let json;
  try {
    json = await readJson(forgeJsonPath(paths, id));
  } catch {
    return false;
  }
  for (const lib of json.libraries || []) {
    const rel = (lib.downloads && lib.downloads.artifact && lib.downloads.artifact.path) || mavenPath(lib.name);
    if (!fs.existsSync(path.join(paths.libraries, ...rel.split('/')))) return false;
  }
  return true;
}

function runInstaller(javaExe, installer, root, { cwd, onLog, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(javaExe, ['-jar', installer, '--installClient', root], { cwd, windowsHide: true });
    const tail = [];
    const onData = (buf) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 40) tail.shift();
        if (onLog) onLog(`[forge] ${line}`);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const onAbort = () => child.kill();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) return reject(signal.reason);
      if (code === 0) resolve();
      else reject(new Error(`Установщик Forge завершился с кодом ${code}:\n${tail.slice(-12).join('\n')}`));
    });
  });
}

async function ensureForge(paths, { mc, forge, javaExe, onLog, signal, force = false }) {
  const id = forgeVersionId(mc, forge);
  if (!force && (await isForgeInstalled(paths, id))) {
    return { id, json: await readJson(forgeJsonPath(paths, id)), installed: false };
  }
  const full = `${mc}-${forge}`;
  const url = `${FORGE_MAVEN}/${full}/forge-${full}-installer.jar`;
  const sha1 = (await fetchText(`${url}.sha1`, { signal })).trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/i.test(sha1)) throw new Error('Не удалось получить контрольную сумму установщика Forge');
  const installer = path.join(paths.temp, `forge-${full}-installer.jar`);
  if (onLog) onLog(`[forge] скачиваю установщик ${full}`);
  await downloadFile({ url, dest: installer, hash: sha1, algo: 'sha1', signal });

  // Установщику нужен launcher_profiles.json, как у официального лаунчера.
  const profiles = path.join(paths.root, 'launcher_profiles.json');
  if (!fs.existsSync(profiles)) await fsp.writeFile(profiles, JSON.stringify({ profiles: {} }, null, 2));

  await fsp.mkdir(paths.temp, { recursive: true });
  await runInstaller(javaExe, installer, paths.root, { cwd: paths.temp, onLog, signal });
  await fsp.rm(installer, { force: true });
  if (!(await isForgeInstalled(paths, id))) throw new Error('Forge установился не полностью — нажмите «Проверить файлы»');
  return { id, json: await readJson(forgeJsonPath(paths, id)), installed: true };
}

// Библиотеки Forge, которые можно перепроверить и докачать без установщика.
function planForgeLibraries(paths, forgeJson) {
  return libraryFiles(paths, forgeJson.libraries);
}

module.exports = { forgeVersionId, ensureForge, isForgeInstalled, planForgeLibraries };
