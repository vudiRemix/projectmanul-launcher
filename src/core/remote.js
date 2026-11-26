'use strict';
// Настройки сервера и новости из репозитория (обычные файлы, без подписи).
const fsp = require('fs').promises;
const path = require('path');
const { fetchJson } = require('./http');

const DEFAULT_REMOTE = {
  server: { host: 'localhost', port: 25565 },
  nickCheckUrl: '',
  autoConnect: false,
  maintenance: { enabled: false, message: '' },
  discord: { clientId: '', image: 'logo', inviteUrl: '' },
};

function cleanRemote(raw) {
  const r = { ...DEFAULT_REMOTE, ...(raw || {}) };
  const server = r.server || {};
  const port = Number(server.port);
  r.server = {
    host: typeof server.host === 'string' && /^[A-Za-z0-9.-]{1,253}$/.test(server.host) ? server.host : DEFAULT_REMOTE.server.host,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 25565,
  };
  r.nickCheckUrl = typeof r.nickCheckUrl === 'string' && /^https?:\/\//.test(r.nickCheckUrl) && r.nickCheckUrl.includes('{nick}') ? r.nickCheckUrl : '';
  // true — игра сразу заходит на сервер; false — открывается главное меню.
  r.autoConnect = r.autoConnect === true;
  r.maintenance = {
    enabled: Boolean(r.maintenance && r.maintenance.enabled),
    message: (r.maintenance && r.maintenance.message) || '',
  };
  // Статус в Discord: clientId — Application ID приложения в Discord Developer Portal.
  const d = r.discord || {};
  r.discord = {
    clientId: typeof d.clientId === 'string' && /^\d{15,25}$/.test(d.clientId.trim()) ? d.clientId.trim() : '',
    image: typeof d.image === 'string' && /^[\w.-]{1,64}$/.test(d.image) ? d.image : 'logo',
    inviteUrl: typeof d.inviteUrl === 'string' && /^https:\/\/(discord\.gg|discord\.com\/invite)\/[\w-]+$/.test(d.inviteUrl.trim()) ? d.inviteUrl.trim() : '',
  };
  return r;
}

async function cachedFetch(url, cacheFile) {
  try {
    const data = await fetchJson(url, { noCache: true, timeoutMs: 8000 });
    await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
    await fsp.writeFile(cacheFile, JSON.stringify(data));
    return { data, offline: false };
  } catch (err) {
    try {
      return { data: JSON.parse(await fsp.readFile(cacheFile, 'utf8')), offline: true };
    } catch {
      return { data: null, offline: true, error: err.message };
    }
  }
}

async function loadRemoteConfig(config, cacheDir) {
  const res = await cachedFetch(config.remoteConfigUrl, path.join(cacheDir, 'remote-config.json'));
  return { ...cleanRemote(res.data), offline: res.offline };
}

function cleanNews(raw) {
  const items = Array.isArray(raw && raw.items) ? raw.items : [];
  return items
    .filter((n) => n && (n.title || n.text))
    .slice(0, 20)
    .map((n) => ({
      date: typeof n.date === 'string' ? n.date : '',
      tag: n.tag || '',
      title: n.title || '',
      text: n.text || '',
      image: typeof n.image === 'string' && n.image.startsWith('https://') ? n.image : '',
      link: typeof n.link === 'string' && n.link.startsWith('https://') ? n.link : '',
    }));
}

async function loadNews(config, cacheDir) {
  const res = await cachedFetch(config.newsUrl, path.join(cacheDir, 'news.json'));
  return { items: cleanNews(res.data), offline: res.offline };
}

module.exports = { loadRemoteConfig, loadNews, cleanRemote, cleanNews };
