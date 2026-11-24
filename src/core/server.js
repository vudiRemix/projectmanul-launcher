'use strict';
// Статус сервера (Server List Ping) и проверка, занят ли ник в AuthMe.
const net = require('net');
const { fetchWithTimeout } = require('./http');

const PROTOCOL_1_20_1 = 763;

function writeVarInt(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new RangeError('incomplete');
    const b = buf[pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result, pos];
    shift += 7;
    if (shift > 35) throw new Error('VarInt слишком длинный');
  }
}

function packet(id, payload) {
  const body = Buffer.concat([writeVarInt(id), payload]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

function pingServer(host, port, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const socket = net.createConnection({ host, port });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error('Сервер не ответил')));
    socket.on('error', (err) => finish(err));
    socket.on('connect', () => {
      const hostBuf = Buffer.from(host, 'utf8');
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);
      const handshake = Buffer.concat([writeVarInt(PROTOCOL_1_20_1), writeVarInt(hostBuf.length), hostBuf, portBuf, writeVarInt(1)]);
      socket.write(packet(0x00, handshake));
      socket.write(packet(0x00, Buffer.alloc(0)));
    });
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        const [len, off] = readVarInt(buf, 0);
        if (buf.length < off + len) return;
        const [, afterId] = readVarInt(buf, off);
        const [strLen, strOff] = readVarInt(buf, afterId);
        const status = JSON.parse(buf.subarray(strOff, strOff + strLen).toString('utf8'));
        finish(null, {
          online: true,
          players: (status.players && status.players.online) || 0,
          maxPlayers: (status.players && status.players.max) || 0,
          version: status.version && status.version.name,
          latency: Date.now() - started,
        });
      } catch (err) {
        if (!(err instanceof RangeError)) finish(err);
      }
    });
  });
}

const NICK_RE = /^[A-Za-z0-9_]{3,16}$/;

// Ответ сервиса проверки ника: {"registered": true|false}. Любая ошибка = "unknown", вход не блокируем.
async function checkNick(urlTemplate, nick) {
  if (!urlTemplate || !NICK_RE.test(nick)) return { status: 'unknown' };
  try {
    const url = urlTemplate.replace('{nick}', encodeURIComponent(nick));
    const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 3000);
    if (!res.ok) return { status: 'unknown' };
    const body = await res.json();
    if (typeof body.registered !== 'boolean') return { status: 'unknown' };
    return { status: body.registered ? 'registered' : 'free' };
  } catch {
    return { status: 'unknown' };
  }
}

module.exports = { pingServer, checkNick, NICK_RE, writeVarInt, readVarInt };
