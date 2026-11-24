'use strict';
// Манифест сборки: список файлов с хешами. Лаунчер принимает его только с верной подписью Ed25519.
const crypto = require('crypto');
const fsp = require('fs').promises;
const path = require('path');
const { fetchBuffer, fetchText } = require('./http');

const HEX64 = /^[0-9a-f]{64}$/;
// Эти папки лаунчер никогда не чистит, что бы ни было в манифесте.
const NEVER_CLEAN = new Set(['shaderpacks', 'saves', 'screenshots', 'logs', 'crash-reports', 'runtime', 'libraries', 'assets', 'versions', 'natives', '.launcher']);

function publicKeyFrom(b64) {
  return crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
}

function verifySignature(body, signatureB64, publicKeyB64) {
  const sig = Buffer.from(String(signatureB64).trim(), 'base64');
  if (sig.length !== 64) return false;
  return crypto.verify(null, body, publicKeyFrom(publicKeyB64), sig);
}

function validateManifest(m) {
  const fail = (msg) => {
    throw new Error(`Манифест повреждён: ${msg}`);
  };
  if (!m || m.format !== 1) fail('неизвестный формат');
  if (typeof m.version !== 'string' || !m.version) fail('нет версии сборки');
  if (typeof m.minecraft !== 'string' || typeof m.forge !== 'string') fail('нет версий Minecraft/Forge');
  if (!Array.isArray(m.files)) fail('нет списка файлов');
  const seen = new Set();
  for (const f of m.files) {
    if (typeof f.path !== 'string' || seen.has(f.path.toLowerCase())) fail(`плохой путь ${f.path}`);
    seen.add(f.path.toLowerCase());
    if (!HEX64.test(f.sha256 || '')) fail(`плохой sha256 у ${f.path}`);
    if (!Number.isInteger(f.size) || f.size < 0) fail(`плохой размер у ${f.path}`);
    if (typeof f.url !== 'string' || !/^(https:|file:)/.test(f.url)) fail(`плохой url у ${f.path}`);
    if (f.mode && f.mode !== 'enforce' && f.mode !== 'once') fail(`плохой режим у ${f.path}`);
  }
  m.cleanDirs = (m.cleanDirs || ['mods']).filter((d) => typeof d === 'string' && /^[A-Za-z0-9_.-]+$/.test(d) && !NEVER_CLEAN.has(d));
  if (m.launcher) {
    const l = m.launcher;
    if (typeof l.version !== 'string' || typeof l.url !== 'string' || !HEX64.test(l.sha256 || '')) delete m.launcher;
  }
  return m;
}

async function fetchManifest(config, paths, { signal } = {}) {
  const [body, sig] = await Promise.all([
    fetchBuffer(config.manifestUrl, { noCache: true, signal }),
    fetchText(`${config.manifestUrl}.sig`, { noCache: true, signal }),
  ]);
  if (!verifySignature(body, sig, config.publicKey)) {
    throw new Error('Подпись манифеста не сошлась — сборка не установлена. Сообщите администратору.');
  }
  const manifest = validateManifest(JSON.parse(body.toString('utf8')));
  await fsp.mkdir(path.dirname(paths.manifestCache), { recursive: true });
  await fsp.writeFile(paths.manifestCache, body);
  await fsp.writeFile(`${paths.manifestCache}.sig`, sig);
  return { manifest, offline: false };
}

// Последний проверенный манифест — чтобы играть, если GitHub недоступен.
async function loadCachedManifest(config, paths) {
  const body = await fsp.readFile(paths.manifestCache);
  const sig = await fsp.readFile(`${paths.manifestCache}.sig`, 'utf8');
  if (!verifySignature(body, sig, config.publicKey)) throw new Error('Сохранённый манифест повреждён');
  return { manifest: validateManifest(JSON.parse(body.toString('utf8'))), offline: true };
}

async function getManifest(config, paths, opts) {
  try {
    return await fetchManifest(config, paths, opts);
  } catch (err) {
    if (err.message.startsWith('Подпись')) throw err;
    try {
      return await loadCachedManifest(config, paths);
    } catch {
      throw err;
    }
  }
}

module.exports = { getManifest, verifySignature, validateManifest, NEVER_CLEAN };
