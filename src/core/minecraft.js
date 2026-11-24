'use strict';
// Ванильный Minecraft: version.json, клиентский jar, библиотеки, ассеты и конфиг логов.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { fetchJson, downloadFile } = require('./http');
const { fileMatches } = require('./hash');
const { rulesAllow, mavenPath, OS_NAME } = require('./rules');

const VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const RESOURCES = 'https://resources.download.minecraft.net';

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

async function loadVanillaVersion(paths, mcVersion, { signal } = {}) {
  const jsonPath = path.join(paths.versions, mcVersion, `${mcVersion}.json`);
  try {
    const manifest = await fetchJson(VERSION_MANIFEST, { signal });
    const entry = manifest.versions.find((v) => v.id === mcVersion);
    if (!entry) throw new Error(`Mojang не знает версию ${mcVersion}`);
    if (!(await fileMatches(jsonPath, { hash: entry.sha1, algo: 'sha1' }))) {
      await downloadFile({ url: entry.url, dest: jsonPath, hash: entry.sha1, algo: 'sha1', signal });
    }
  } catch (err) {
    if (!fs.existsSync(jsonPath)) throw err;
  }
  return readJson(jsonPath);
}

function libraryFiles(paths, libraries) {
  const files = [];
  for (const lib of libraries || []) {
    if (!rulesAllow(lib.rules)) continue;
    const art = lib.downloads && lib.downloads.artifact;
    if (art && art.url) {
      files.push({
        url: art.url,
        dest: path.join(paths.libraries, ...(art.path || mavenPath(lib.name)).split('/')),
        size: art.size,
        hash: art.sha1,
        algo: 'sha1',
        label: lib.name,
      });
    }
    // Старый формат нативных библиотек (natives + classifiers). В 1.20.1 почти не встречается.
    if (lib.natives && lib.downloads && lib.downloads.classifiers) {
      const key = (lib.natives[OS_NAME] || '').replace('${arch}', process.arch === 'ia32' ? '32' : '64');
      const c = lib.downloads.classifiers[key];
      if (c && c.url) {
        files.push({ url: c.url, dest: path.join(paths.libraries, ...c.path.split('/')), size: c.size, hash: c.sha1, algo: 'sha1', label: `${lib.name}:${key}` });
      }
    }
  }
  return files;
}

function planVanillaFiles(paths, version) {
  const files = [];
  const client = version.downloads.client;
  files.push({
    url: client.url,
    dest: path.join(paths.versions, version.id, `${version.id}.jar`),
    size: client.size,
    hash: client.sha1,
    algo: 'sha1',
    label: `${version.id}.jar`,
  });
  files.push(...libraryFiles(paths, version.libraries));
  const log = version.logging && version.logging.client && version.logging.client.file;
  if (log) {
    files.push({ url: log.url, dest: path.join(paths.assets, 'log_configs', log.id), size: log.size, hash: log.sha1, algo: 'sha1', label: log.id });
  }
  return files;
}

async function planAssets(paths, version, { signal } = {}) {
  const idx = version.assetIndex;
  const idxPath = path.join(paths.assets, 'indexes', `${idx.id}.json`);
  if (!(await fileMatches(idxPath, { size: idx.size, hash: idx.sha1, algo: 'sha1' }))) {
    await downloadFile({ url: idx.url, dest: idxPath, size: idx.size, hash: idx.sha1, algo: 'sha1', signal });
  }
  const index = await readJson(idxPath);
  const seen = new Set();
  const files = [];
  for (const [name, obj] of Object.entries(index.objects)) {
    if (seen.has(obj.hash)) continue;
    seen.add(obj.hash);
    const sub = obj.hash.slice(0, 2);
    files.push({
      url: `${RESOURCES}/${sub}/${obj.hash}`,
      dest: path.join(paths.assets, 'objects', sub, obj.hash),
      size: obj.size,
      hash: obj.hash,
      algo: 'sha1',
      label: name,
    });
  }
  return files;
}

module.exports = { loadVanillaVersion, planVanillaFiles, planAssets, libraryFiles, readJson };
