'use strict';
// Сборка командной строки Java так же, как это делает официальный лаунчер для профиля Forge.
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { rulesAllow, mavenPath, libraryKey } = require('./rules');
const { fileMatches } = require('./hash');

// UUID офлайн-игрока — тот же, что вычисляет сервер в offline-mode (UUID v3 от "OfflinePlayer:<ник>").
function offlineUuid(name) {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  return md5.toString('hex');
}

function mergeVersions(vanilla, forge) {
  const libs = [];
  const seen = new Set();
  for (const lib of [...(forge.libraries || []), ...(vanilla.libraries || [])]) {
    const key = libraryKey(lib.name);
    if (seen.has(key)) continue;
    seen.add(key);
    libs.push(lib);
  }
  return {
    id: forge.id,
    mainClass: forge.mainClass || vanilla.mainClass,
    libraries: libs,
    arguments: {
      game: [...((vanilla.arguments || {}).game || []), ...((forge.arguments || {}).game || [])],
      jvm: [...((vanilla.arguments || {}).jvm || []), ...((forge.arguments || {}).jvm || [])],
    },
    assetIndex: vanilla.assetIndex,
    type: forge.type || vanilla.type || 'release',
  };
}

function substitute(str, vars) {
  return str.replace(/\$\{([^}]+)\}/g, (m, key) => (Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m));
}

function collectArgs(list, features, vars) {
  const out = [];
  for (const item of list || []) {
    if (typeof item === 'string') {
      out.push(substitute(item, vars));
    } else if (item && rulesAllow(item.rules, features)) {
      const values = Array.isArray(item.value) ? item.value : [item.value];
      out.push(...values.map((s) => substitute(s, vars)));
    }
  }
  return out;
}

// Разбивает строку доп. аргументов JVM с учётом кавычек.
function splitArgs(text) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(text || '')) !== null) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

async function buildLaunch({ paths, vanilla, forgeJson, java, settings, server, appVersion, launcherName }) {
  const v = mergeVersions(vanilla, forgeJson);

  // Как официальный лаунчер: jar профиля = копия ванильного jar с именем профиля.
  const vanillaJar = path.join(paths.versions, vanilla.id, `${vanilla.id}.jar`);
  const versionJar = path.join(paths.versions, v.id, `${v.id}.jar`);
  if (!(await fileMatches(versionJar, { size: vanilla.downloads.client.size, quick: true }))) {
    await fsp.mkdir(path.dirname(versionJar), { recursive: true });
    await fsp.copyFile(vanillaJar, versionJar);
  }

  const classpath = [];
  const added = new Set();
  for (const lib of v.libraries) {
    if (!rulesAllow(lib.rules)) continue;
    if (lib.natives) continue;
    const rel = (lib.downloads && lib.downloads.artifact && lib.downloads.artifact.path) || mavenPath(lib.name);
    const abs = path.join(paths.libraries, ...rel.split('/'));
    if (added.has(abs)) continue;
    added.add(abs);
    classpath.push(abs);
  }
  classpath.push(versionJar);

  const nativesDir = path.join(paths.natives, v.id);
  await fsp.mkdir(nativesDir, { recursive: true });

  const nick = settings.nick;
  const width = settings.width || 1280;
  const height = settings.height || 720;
  const vars = {
    auth_player_name: nick,
    version_name: v.id,
    game_directory: paths.gameDir,
    assets_root: paths.assets,
    game_assets: paths.assets,
    assets_index_name: v.assetIndex.id,
    auth_uuid: offlineUuid(nick),
    auth_access_token: '0',
    auth_session: '0',
    clientid: '0',
    auth_xuid: '0',
    user_type: 'legacy',
    user_properties: '{}',
    version_type: v.type,
    natives_directory: nativesDir,
    launcher_name: launcherName,
    launcher_version: appVersion,
    classpath: classpath.join(path.delimiter),
    classpath_separator: path.delimiter,
    library_directory: paths.libraries,
    resolution_width: width,
    resolution_height: height,
    quickPlayMultiplayer: server ? `${server.host}:${server.port}` : '',
  };
  const features = {
    has_custom_resolution: !settings.fullscreen,
    is_quick_play_multiplayer: Boolean(server),
  };

  const ram = Math.max(2, Number(settings.ramGb) || 4);
  const jvm = [`-Xms1G`, `-Xmx${ram}G`, ...splitArgs(settings.jvmArgs), ...collectArgs(v.arguments.jvm, features, vars)];
  const game = collectArgs(v.arguments.game, features, vars);
  if (settings.fullscreen) game.push('--fullscreen');

  return {
    executable: java.javaw,
    args: [...jvm, v.mainClass, ...game],
    cwd: paths.gameDir,
    versionId: v.id,
  };
}

module.exports = { offlineUuid, mergeVersions, collectArgs, substitute, splitArgs, buildLaunch };
