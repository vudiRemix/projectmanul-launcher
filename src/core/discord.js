'use strict';
// Статус в Discord («Играет в Project Manul») через локальный канал Discord (IPC), без библиотек.
// Если Discord не запущен — тихо пробуем снова раз в 30 секунд. Ошибки никогда не мешают игре.
const net = require('net');
const crypto = require('crypto');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const RETRY_MS = 30000;

function pipePath(i) {
  if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${i}`;
  const dir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';
  return `${dir.replace(/\/$/, '')}/discord-ipc-${i}`;
}

function encode(op, data) {
  const json = Buffer.from(JSON.stringify(data), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

function connectPipe(name, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(name);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('timeout'));
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// Текст статуса Discord ограничивает 128 символами, кнопки — 32.
const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n - 1)}…` : s);

function cleanActivity(a) {
  if (!a) return null;
  const out = {};
  if (a.details) out.details = clip(a.details, 128);
  if (a.state) out.state = clip(a.state, 128);
  if (a.start) out.timestamps = { start: a.start };
  if (a.image) out.assets = { large_image: a.image, large_text: clip(a.imageText || '', 128) || undefined };
  if (Array.isArray(a.party) && a.party[1] > 0) out.party = { id: 'server', size: [Math.max(1, a.party[0]), a.party[1]] };
  const buttons = (a.buttons || []).filter((b) => b && b.label && /^https:\/\//.test(b.url || '')).slice(0, 2);
  if (buttons.length) out.buttons = buttons.map((b) => ({ label: clip(b.label, 32), url: b.url }));
  out.instance = false;
  return out;
}

class DiscordPresence {
  constructor({ logger, pipeName = pipePath } = {}) {
    this.logger = logger;
    this.pipeName = pipeName;
    this.clientId = '';
    this.activity = null;
    this.sock = null;
    this.ready = false;
    this.connecting = false;
    this.retryTimer = null;
    this.buf = Buffer.alloc(0);
    this.stopped = false;
  }

  log(msg) {
    if (this.logger) this.logger.log(`Discord: ${msg}`);
  }

  // clientId — Application ID из Discord Developer Portal. Пустой — статус выключен.
  setClientId(id) {
    const clean = typeof id === 'string' && /^\d{15,25}$/.test(id) ? id : '';
    if (clean === this.clientId) return;
    this.clientId = clean;
    this.disconnect();
    if (clean) this.connect();
  }

  // activity: { details, state, start, image, imageText, party: [online, max], buttons: [{label, url}] } или null.
  set(activity) {
    this.activity = cleanActivity(activity);
    if (this.ready) this.sendActivity();
    else if (this.clientId) this.connect();
  }

  sendActivity() {
    if (!this.sock || !this.ready) return;
    this.write(OP.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity: this.activity },
      nonce: crypto.randomUUID(),
    });
  }

  write(op, data) {
    try {
      this.sock.write(encode(op, data));
    } catch {
      this.disconnect(true);
    }
  }

  async connect() {
    if (this.stopped || this.connecting || this.sock || !this.clientId) return;
    clearTimeout(this.retryTimer);
    this.connecting = true;
    let sock = null;
    for (let i = 0; i < 10 && !sock; i += 1) {
      try {
        sock = await connectPipe(this.pipeName(i));
      } catch {
        /* следующий канал */
      }
    }
    this.connecting = false;
    if (this.stopped || !this.clientId) {
      if (sock) sock.destroy();
      return;
    }
    if (!sock) return this.scheduleRetry();
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    sock.on('data', (chunk) => this.onData(chunk));
    sock.on('error', () => this.disconnect(true));
    sock.on('close', () => this.disconnect(true));
    this.write(OP.HANDSHAKE, { v: 1, client_id: this.clientId });
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 8) {
      const op = this.buf.readInt32LE(0);
      const len = this.buf.readInt32LE(4);
      if (this.buf.length < 8 + len) return;
      let msg = null;
      try {
        msg = JSON.parse(this.buf.subarray(8, 8 + len).toString('utf8'));
      } catch {
        /* битый кадр — пропускаем */
      }
      this.buf = this.buf.subarray(8 + len);
      this.onMessage(op, msg);
    }
  }

  onMessage(op, msg) {
    if (op === OP.PING) return this.write(OP.PONG, msg);
    if (op === OP.CLOSE) {
      this.log(`соединение закрыто: ${(msg && msg.message) || 'без причины'}`);
      // Неверный Application ID: не долбимся каждые 30 секунд.
      if (msg && msg.code === 4000) this.clientId = '';
      return this.disconnect(true);
    }
    if (!msg) return;
    if (msg.cmd === 'DISPATCH' && msg.evt === 'READY') {
      if (!this.ready) this.log('подключён');
      this.ready = true;
      this.sendActivity();
    } else if (msg.evt === 'ERROR') {
      this.log(`ошибка: ${(msg.data && msg.data.message) || JSON.stringify(msg.data)}`);
    }
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    if (this.stopped || !this.clientId) return;
    this.retryTimer = setTimeout(() => this.connect(), RETRY_MS);
    if (this.retryTimer.unref) this.retryTimer.unref();
  }

  disconnect(retry = false) {
    const wasReady = this.ready;
    this.ready = false;
    if (this.sock) {
      const s = this.sock;
      this.sock = null;
      s.removeAllListeners();
      s.on('error', () => {});
      s.destroy();
      if (wasReady) this.log('отключён');
    }
    if (retry) this.scheduleRetry();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    if (this.sock && this.ready) {
      // Убираем статус сразу, не дожидаясь, пока Discord заметит закрытие процесса.
      this.activity = null;
      this.sendActivity();
    }
    this.disconnect();
  }
}

module.exports = { DiscordPresence, cleanActivity, encode, pipePath };
