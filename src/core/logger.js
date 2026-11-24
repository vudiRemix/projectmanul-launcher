'use strict';
// Лог лаунчера и игры: кольцевой буфер для вкладки «Логи» + файл на диске.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

class Logger extends EventEmitter {
  constructor(file, limit = 3000) {
    super();
    this.file = file;
    this.limit = limit;
    this.lines = [];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Храним предыдущий лог рядом, чтобы не терять его при перезапуске.
    try {
      fs.renameSync(file, `${file}.1`);
    } catch {
      /* первого лога ещё нет */
    }
    this.stream = fs.createWriteStream(file, { flags: 'a' });
  }

  log(message) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const line = `[${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}] ${message}`;
    this.lines.push(line);
    if (this.lines.length > this.limit) this.lines.splice(0, this.lines.length - this.limit);
    this.stream.write(`${line}\n`);
    this.emit('line', line);
  }

  error(message, err) {
    this.log(`ОШИБКА: ${message}${err ? ` — ${err.stack || err.message || err}` : ''}`);
  }

  tail(n = 200) {
    return this.lines.slice(-n);
  }
}

module.exports = { Logger };
