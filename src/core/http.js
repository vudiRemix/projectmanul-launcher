'use strict';
// Загрузки: докачка после обрыва, проверка размера и хеша, повторы, file:// для локальных тестов.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { fileURLToPath } = require('url');
const { hashFile } = require('./hash');

const USER_AGENT = 'MilsimLauncher/1.0 (+https://github.com)';
const STALL_TIMEOUT_MS = 30000;

class HttpError extends Error {
  constructor(url, status) {
    super(`HTTP ${status}: ${url}`);
    this.status = status;
    this.url = url;
  }
}

class IntegrityError extends Error {}

function isFileUrl(url) {
  return url.startsWith('file:');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`Таймаут запроса: ${url}`)), timeoutMs);
  const outer = options.signal;
  const onAbort = () => ctrl.abort(outer.reason);
  if (outer) outer.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, {
      redirect: 'follow',
      ...options,
      headers: { 'User-Agent': USER_AGENT, ...(options.headers || {}) },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener('abort', onAbort);
  }
}

async function fetchBuffer(url, { timeoutMs = 20000, noCache = false, signal } = {}) {
  if (isFileUrl(url)) return fsp.readFile(fileURLToPath(url));
  const headers = noCache ? { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } : {};
  const res = await fetchWithTimeout(url, { headers, signal }, timeoutMs);
  if (!res.ok) throw new HttpError(url, res.status);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchText(url, opts) {
  return (await fetchBuffer(url, opts)).toString('utf8');
}

async function fetchJson(url, opts) {
  return JSON.parse(await fetchText(url, opts));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Скачивает url в dest через dest.part. onProgress(deltaBytes) получает и отрицательные
// значения, если попытка сорвалась и счётчик надо откатить.
async function downloadFile({ url, dest, size, hash, algo = 'sha256', onProgress, signal, retries = 4 }) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let counted = 0;
  const report = (n) => {
    counted += n;
    if (onProgress) onProgress(n);
  };

  for (let attempt = 1; ; attempt++) {
    try {
      if (isFileUrl(url)) {
        await fsp.copyFile(fileURLToPath(url), part);
        report((await fsp.stat(part)).size - counted);
      } else {
        await downloadOnce(url, part, report, () => counted, signal);
      }
      const st = await fsp.stat(part);
      if (size != null && st.size !== size) {
        await fsp.rm(part, { force: true });
        throw new IntegrityError(`Размер не совпал (${st.size} вместо ${size}): ${url}`);
      }
      if (hash) {
        const actual = await hashFile(part, algo);
        if (actual !== hash.toLowerCase()) {
          await fsp.rm(part, { force: true });
          throw new IntegrityError(`Хеш не совпал: ${url}`);
        }
      }
      await fsp.rename(part, dest);
      return;
    } catch (err) {
      if (signal && signal.aborted) throw signal.reason || err;
      if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
        throw err;
      }
      if (attempt >= retries) throw err;
      report(-counted);
      await sleep(800 * attempt);
    }
  }
}

async function downloadOnce(url, part, report, getCounted, signal) {
  let start = 0;
  try {
    start = (await fsp.stat(part)).size;
  } catch {
    start = 0;
  }
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  let stallTimer;
  const arm = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => ctrl.abort(new Error(`Загрузка зависла: ${url}`)), STALL_TIMEOUT_MS);
  };
  try {
    arm();
    const headers = { 'User-Agent': USER_AGENT };
    if (start > 0) headers.Range = `bytes=${start}-`;
    let res = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
    if (res.status === 416) {
      await fsp.rm(part, { force: true });
      start = 0;
      res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow', signal: ctrl.signal });
    }
    if (!res.ok) throw new HttpError(url, res.status);
    const append = start > 0 && res.status === 206;
    // Учитываем уже скачанную часть в прогрессе ровно один раз.
    const already = append ? start : 0;
    report(already - getCounted());
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        arm();
        report(chunk.length);
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(part, { flags: append ? 'a' : 'w' }));
  } finally {
    clearTimeout(stallTimer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

module.exports = {
  USER_AGENT,
  HttpError,
  IntegrityError,
  fetchWithTimeout,
  fetchBuffer,
  fetchText,
  fetchJson,
  downloadFile,
};
