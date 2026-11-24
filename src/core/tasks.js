'use strict';
// Параллельная обработка списка с ограничением и общий трекер прогресса загрузок.
const { fileMatches } = require('./hash');
const { downloadFile } = require('./http');

async function runPool(items, limit, worker, signal) {
  let next = 0;
  let failed = null;
  const runner = async () => {
    while (!failed && next < items.length) {
      if (signal && signal.aborted) throw signal.reason;
      const item = items[next++];
      try {
        await worker(item);
      } catch (err) {
        failed = failed || err;
        throw err;
      }
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  const results = await Promise.allSettled(Array.from({ length: n }, runner));
  const rejected = results.find((r) => r.status === 'rejected');
  if (rejected) throw failed || rejected.reason;
}

class Progress {
  constructor(emit, intervalMs = 150) {
    this.emit = emit;
    this.intervalMs = intervalMs;
    this.reset('', 0, 0);
  }

  reset(stage, totalBytes, totalFiles) {
    this.stage = stage;
    this.totalBytes = totalBytes;
    this.doneBytes = 0;
    this.totalFiles = totalFiles;
    this.doneFiles = 0;
    this.current = '';
    this.samples = [];
    this.lastEmit = 0;
    this.flush(true);
  }

  addBytes(n) {
    this.doneBytes += n;
    const now = Date.now();
    this.samples.push([now, this.doneBytes]);
    while (this.samples.length > 2 && now - this.samples[0][0] > 3000) this.samples.shift();
    this.flush(false);
  }

  fileDone(name) {
    this.doneFiles += 1;
    this.current = name || this.current;
    this.flush(false);
  }

  speed() {
    if (this.samples.length < 2) return 0;
    const [t0, b0] = this.samples[0];
    const [t1, b1] = this.samples[this.samples.length - 1];
    return t1 > t0 ? ((b1 - b0) * 1000) / (t1 - t0) : 0;
  }

  flush(force) {
    const now = Date.now();
    if (!force && now - this.lastEmit < this.intervalMs) return;
    this.lastEmit = now;
    const speed = this.speed();
    const left = this.totalBytes - this.doneBytes;
    this.emit({
      stage: this.stage,
      doneBytes: Math.max(0, this.doneBytes),
      totalBytes: this.totalBytes,
      doneFiles: this.doneFiles,
      totalFiles: this.totalFiles,
      current: this.current,
      speed,
      eta: speed > 0 && left > 0 ? Math.round(left / speed) : null,
      // Нет ни байтов, ни файлов (например, работает установщик Forge) — прогресс неизвестен.
      indeterminate: this.totalBytes === 0 && this.totalFiles === 0,
      percent: this.totalBytes > 0 ? Math.min(100, (this.doneBytes / this.totalBytes) * 100) : this.totalFiles > 0 ? (this.doneFiles / this.totalFiles) * 100 : 0,
    });
  }
}

// files: [{ url, dest, size, hash, algo, label }]. Проверяет, что уже есть, и докачивает остальное.
async function syncFiles(files, { stage, progress, concurrency = 8, full = false, signal, log }) {
  const missing = [];
  progress.reset(`${stage}:check`, 0, files.length);
  await runPool(
    files,
    16,
    async (f) => {
      const ok = await fileMatches(f.dest, { size: f.size, hash: f.hash, algo: f.algo, quick: !full && !f.alwaysHash });
      if (!ok) missing.push(f);
      progress.fileDone();
    },
    signal,
  );
  if (missing.length === 0) return { downloaded: 0 };
  const totalBytes = missing.reduce((s, f) => s + (f.size || 0), 0);
  progress.reset(stage, totalBytes, missing.length);
  if (log) log(`[${stage}] скачиваю ${missing.length} файлов, ${(totalBytes / 1048576).toFixed(1)} МБ`);
  await runPool(
    missing,
    concurrency,
    async (f) => {
      await downloadFile({ ...f, onProgress: (n) => progress.addBytes(n), signal });
      progress.fileDone(f.label || f.dest);
    },
    signal,
  );
  progress.flush(true);
  return { downloaded: missing.length };
}

module.exports = { runPool, Progress, syncFiles };
