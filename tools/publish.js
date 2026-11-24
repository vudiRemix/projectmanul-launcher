'use strict';
// Выпуск новой версии сборки одной командой.
//
//   set GITHUB_TOKEN=<токен с правом Contents: write на репозиторий>
//   node tools/publish.js --config publish.config.json [--version 2026.11.24] [--notes "что нового"]
//
// Режимы для проверки:
//   --dry-run         только посчитать, что будет загружено
//   --local <папка>   собрать манифест и файлы в папку (ссылки file://) для теста лаунчера без GitHub
//
// Что делает: собирает файлы из папок include, считает SHA-256, загружает на GitHub Releases
// только новые и изменённые (неизменённые берёт по ссылкам из прошлых релизов), подписывает
// manifest.json ключом Ed25519 и публикует релиз как latest.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

function die(msg) {
  console.error(`\nОШИБКА: ${msg}`);
  process.exit(1);
}

// Простейший glob: ** — любые папки, * — любые символы в имени, ? — один символ.
function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

function walk(absDir, relDir, out) {
  for (const e of fs.readdirSync(absDir, { withFileTypes: true })) {
    const abs = path.join(absDir, e.name);
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    if (e.isDirectory()) walk(abs, rel, out);
    else if (e.isFile()) out.push({ abs, rel });
  }
  return out;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function assetName(sha, rel) {
  const base = path.posix.basename(rel).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180);
  return `${sha.slice(0, 12)}-${base}`;
}

function loadConfig() {
  const cfgPath = path.resolve(arg('config', 'publish.config.json'));
  if (!fs.existsSync(cfgPath)) die(`нет файла ${cfgPath}. Скопируйте publish.config.example.json и заполните его.`);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const base = path.dirname(cfgPath);
  const abs = (p) => (p ? path.resolve(base, p) : p);
  cfg.source = abs(cfg.source);
  cfg.privateKey = abs(cfg.privateKey);
  if (cfg.launcher && cfg.launcher.installer) cfg.launcher.installer = abs(cfg.launcher.installer);
  for (const key of ['source', 'privateKey', 'minecraft', 'forge']) if (!cfg[key]) die(`в ${cfgPath} не заполнено поле "${key}"`);
  if (!Array.isArray(cfg.include) || cfg.include.length === 0) die('поле "include" должно быть списком папок/файлов');
  if (!fs.existsSync(cfg.source)) die(`папка сборки не найдена: ${cfg.source}`);
  if (!fs.existsSync(cfg.privateKey)) die(`приватный ключ не найден: ${cfg.privateKey} (создайте: npm run keygen)`);
  cfg.cleanDirs = cfg.cleanDirs || ['mods'];
  return cfg;
}

function collectFiles(cfg) {
  const exclude = (cfg.exclude || []).map(globToRegex);
  const once = (cfg.once || []).map(globToRegex);
  const files = [];
  for (const entry of cfg.include) {
    const abs = path.join(cfg.source, ...entry.split('/'));
    if (!fs.existsSync(abs)) {
      console.warn(`  пропускаю: нет ${entry}`);
      continue;
    }
    const st = fs.statSync(abs);
    const found = st.isDirectory() ? walk(abs, entry, []) : [{ abs, rel: entry }];
    for (const f of found) {
      if (exclude.some((r) => r.test(f.rel))) continue;
      if (f.rel.startsWith('shaderpacks/')) continue;
      files.push(f);
    }
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  console.log(`Считаю SHA-256 для ${files.length} файлов…`);
  return files.map((f) => ({
    ...f,
    size: fs.statSync(f.abs).size,
    sha256: sha256File(f.abs),
    mode: once.some((r) => r.test(f.rel)) ? 'once' : 'enforce',
  }));
}

function sign(bytes, keyFile) {
  const key = crypto.createPrivateKey(fs.readFileSync(keyFile));
  const sig = crypto.sign(null, bytes, key).toString('base64');
  const pub = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
  return { sig, pub };
}

function buildManifest(cfg, version, files, urlFor, launcher) {
  const manifest = {
    format: 1,
    version,
    createdAt: new Date().toISOString(),
    minecraft: cfg.minecraft,
    forge: cfg.forge,
    cleanDirs: cfg.cleanDirs,
    files: files.map((f) => {
      const e = { path: f.rel, size: f.size, sha256: f.sha256, url: urlFor(f) };
      if (f.mode === 'once') e.mode = 'once';
      return e;
    }),
  };
  if (launcher) manifest.launcher = launcher;
  return Buffer.from(JSON.stringify(manifest, null, 2));
}

// ---------- GitHub ----------
async function gh(token, method, url, body, headers = {}) {
  const res = await fetch(url.startsWith('http') ? url : `https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'milsim-publisher',
      ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub ${method} ${url}: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

async function previousManifest(repo) {
  try {
    const res = await fetch(`https://github.com/${repo}/releases/latest/download/manifest.json`, { headers: { 'User-Agent': 'milsim-publisher' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function nextTag(token, repo, wanted) {
  const releases = await gh(token, 'GET', `/repos/${repo}/releases?per_page=100`);
  const tags = new Set(releases.map((r) => r.tag_name));
  if (wanted) {
    if (tags.has(`v${wanted}`)) die(`релиз v${wanted} уже существует`);
    return wanted;
  }
  const d = new Date();
  const base = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  if (!tags.has(`v${base}`)) return base;
  for (let n = 2; ; n++) if (!tags.has(`v${base}-${n}`)) return `${base}-${n}`;
}

async function runPool(items, limit, worker) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await worker(items[i++]);
    }),
  );
}

async function publishGitHub(cfg, files) {
  const token = process.env.GITHUB_TOKEN;
  if (!cfg.repo || !/^[\w.-]+\/[\w.-]+$/.test(cfg.repo)) die('в конфиге не указан repo вида "владелец/репозиторий"');
  const dryRun = Boolean(arg('dry-run'));
  if (!token && !dryRun) die('задайте переменную GITHUB_TOKEN (Settings → Developer settings → Fine-grained token, доступ Contents: write)');

  const prev = await previousManifest(cfg.repo);
  const prefix = `https://github.com/${cfg.repo}/releases/download/`;
  const reuse = new Map();
  if (prev && Array.isArray(prev.files)) {
    for (const f of prev.files) if (typeof f.url === 'string' && f.url.startsWith(prefix)) reuse.set(`${f.sha256}:${f.size}`, f.url);
  }
  const toUpload = new Map();
  for (const f of files) if (!reuse.has(`${f.sha256}:${f.size}`)) toUpload.set(f.sha256, f);
  const uploadBytes = [...toUpload.values()].reduce((s, f) => s + f.size, 0);
  console.log(`Файлов в сборке: ${files.length}; новых/изменённых: ${toUpload.size} (${(uploadBytes / 1048576).toFixed(1)} МБ); берутся из прошлых релизов: ${files.length - toUpload.size}`);
  if (toUpload.size > 900) die('GitHub разрешает до 1000 файлов в одном релизе — разбейте обновление или уменьшите число файлов');

  let launcher = prev && prev.launcher ? prev.launcher : undefined;
  const inst = cfg.launcher && cfg.launcher.installer;
  if (dryRun) {
    for (const f of toUpload.values()) console.log(`  + ${f.rel}`);
    console.log('\n--dry-run: ничего не загружено.');
    return;
  }

  const version = await nextTag(token, cfg.repo, arg('version'));
  const tag = `v${version}`;
  console.log(`Создаю черновик релиза ${tag}…`);
  const release = await gh(token, 'POST', `/repos/${cfg.repo}/releases`, {
    tag_name: tag,
    name: `Сборка ${version}`,
    body: typeof arg('notes') === 'string' ? arg('notes') : `Сборка ${version}: Minecraft ${cfg.minecraft}, Forge ${cfg.forge}`,
    draft: true,
  });
  const uploadUrl = (name) => `https://uploads.github.com/repos/${cfg.repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
  const upload = async (name, buf, type = 'application/octet-stream') => {
    const asset = await gh(token, 'POST', uploadUrl(name), buf, { 'Content-Type': type });
    return `${prefix}${tag}/${encodeURIComponent(asset.name)}`;
  };

  try {
    const urls = new Map();
    let done = 0;
    await runPool([...toUpload.values()], 3, async (f) => {
      urls.set(f.sha256, await upload(assetName(f.sha256, f.rel), fs.readFileSync(f.abs)));
      done += 1;
      process.stdout.write(`\r  загружено ${done}/${toUpload.size}   `);
    });
    if (toUpload.size) process.stdout.write('\n');

    if (inst) {
      // Установщик кладётся в каждый релиз под одним именем, чтобы ссылка
      // .../releases/latest/download/<имя> для игроков всегда вела на свежую версию.
      if (!fs.existsSync(inst)) throw new Error(`установщик лаунчера не найден: ${inst}`);
      const buf = fs.readFileSync(inst);
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      const name = cfg.launcher.assetName || 'ProjectManul-Setup.exe';
      console.log(`Загружаю установщик лаунчера ${cfg.launcher.version} (${(buf.length / 1048576).toFixed(0)} МБ)…`);
      launcher = { version: cfg.launcher.version, size: buf.length, sha256: sha, url: await upload(name, buf) };
    }

    const urlFor = (f) => urls.get(f.sha256) || reuse.get(`${f.sha256}:${f.size}`);
    const body = buildManifest(cfg, version, files, urlFor, launcher);
    const { sig, pub } = sign(body, cfg.privateKey);
    await upload('manifest.json', body, 'application/json');
    await upload('manifest.json.sig', Buffer.from(sig), 'text/plain');
    await gh(token, 'PATCH', `/repos/${cfg.repo}/releases/${release.id}`, { draft: false, make_latest: 'true' });
    console.log(`\nГотово: ${tag} опубликован. Лаунчеры получат сборку при следующем запуске.`);
    console.log(`Публичный ключ этой подписи: ${pub}\n(должен совпадать с "publicKey" в launcher.config.json)`);
  } catch (err) {
    console.error('\nСбой — удаляю черновик релиза, чтобы игроки его не получили.');
    await gh(token, 'DELETE', `/repos/${cfg.repo}/releases/${release.id}`).catch(() => {});
    throw err;
  }
}

function publishLocal(cfg, files, outDir) {
  const out = path.resolve(outDir);
  const filesDir = path.join(out, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  for (const f of files) fs.copyFileSync(f.abs, path.join(filesDir, assetName(f.sha256, f.rel)));
  const version = typeof arg('version') === 'string' ? arg('version') : `local-${Date.now()}`;
  const body = buildManifest(cfg, version, files, (f) => pathToFileURL(path.join(filesDir, assetName(f.sha256, f.rel))).href);
  const { sig, pub } = sign(body, cfg.privateKey);
  fs.writeFileSync(path.join(out, 'manifest.json'), body);
  fs.writeFileSync(path.join(out, 'manifest.json.sig'), sig);
  console.log(`Локальная сборка ${version}: ${pathToFileURL(path.join(out, 'manifest.json')).href}`);
  console.log(`Публичный ключ: ${pub}`);
}

async function main() {
  const cfg = loadConfig();
  const files = collectFiles(cfg);
  if (files.length === 0) die('в сборке нет ни одного файла');
  const local = arg('local');
  if (typeof local === 'string') publishLocal(cfg, files, local);
  else await publishGitHub(cfg, files);
}

if (require.main === module) {
  main().catch((err) => die(err.stack || err.message));
}

module.exports = { globToRegex, assetName, buildManifest };
