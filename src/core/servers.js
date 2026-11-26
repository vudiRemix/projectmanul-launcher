'use strict';
// Список серверов Minecraft (servers.dat, несжатый NBT): ставим сервер проекта первым в «Сетевую игру»,
// не трогая серверы, которые игрок добавил сам.
const fsp = require('fs').promises;
const path = require('path');

const T = { END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6, BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12 };

// Значения храним как { type, value }: так файл записывается обратно без потерь.
function readNbt(buf) {
  let pos = 0;
  const need = (n) => {
    if (pos + n > buf.length) throw new Error('servers.dat обрезан');
  };
  const u8 = () => (need(1), buf.readInt8(pos++));
  const i16 = () => (need(2), (pos += 2), buf.readInt16BE(pos - 2));
  const i32 = () => (need(4), (pos += 4), buf.readInt32BE(pos - 4));
  const str = () => {
    need(2);
    const len = buf.readUInt16BE(pos);
    pos += 2;
    need(len);
    pos += len;
    return buf.toString('utf8', pos - len, pos);
  };
  const raw = (n) => (need(n), (pos += n), buf.subarray(pos - n, pos));
  const payload = (type) => {
    switch (type) {
      case T.BYTE: return u8();
      case T.SHORT: return i16();
      case T.INT: return i32();
      case T.LONG: return raw(8);
      case T.FLOAT: return raw(4);
      case T.DOUBLE: return raw(8);
      case T.BYTE_ARRAY: return raw(Math.max(0, i32()));
      case T.STRING: return str();
      case T.LIST: {
        const itemType = u8();
        const n = Math.max(0, i32());
        const items = [];
        for (let i = 0; i < n; i += 1) items.push(payload(itemType));
        return { itemType, items };
      }
      case T.COMPOUND: {
        const entries = [];
        for (;;) {
          const t = u8();
          if (t === T.END) return entries;
          entries.push({ name: str(), type: t, value: payload(t) });
        }
      }
      case T.INT_ARRAY: return raw(Math.max(0, i32()) * 4);
      case T.LONG_ARRAY: return raw(Math.max(0, i32()) * 8);
      default: throw new Error(`неизвестный тег NBT ${type}`);
    }
  };
  const rootType = u8();
  if (rootType !== T.COMPOUND) throw new Error('servers.dat: корень не compound');
  const name = str();
  return { name, value: payload(T.COMPOUND) };
}

function writeNbt(root) {
  const parts = [];
  const u8 = (v) => parts.push(Buffer.from([v & 0xff]));
  const i16 = (v) => {
    const b = Buffer.alloc(2);
    b.writeInt16BE(v);
    parts.push(b);
  };
  const i32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v);
    parts.push(b);
  };
  const str = (s) => {
    const b = Buffer.from(s, 'utf8');
    const h = Buffer.alloc(2);
    h.writeUInt16BE(b.length);
    parts.push(h, b);
  };
  const payload = (type, v) => {
    switch (type) {
      case T.BYTE: return u8(v);
      case T.SHORT: return i16(v);
      case T.INT: return i32(v);
      case T.LONG: case T.FLOAT: case T.DOUBLE: return parts.push(v);
      case T.BYTE_ARRAY: i32(v.length); return parts.push(v);
      case T.STRING: return str(v);
      case T.LIST:
        u8(v.items.length ? v.itemType : T.END);
        i32(v.items.length);
        return v.items.forEach((it) => payload(v.itemType, it));
      case T.COMPOUND:
        for (const e of v) {
          u8(e.type);
          str(e.name);
          payload(e.type, e.value);
        }
        return u8(T.END);
      case T.INT_ARRAY: i32(v.length / 4); return parts.push(v);
      case T.LONG_ARRAY: i32(v.length / 8); return parts.push(v);
      default: throw new Error(`неизвестный тег NBT ${type}`);
    }
  };
  u8(T.COMPOUND);
  str(root.name);
  payload(T.COMPOUND, root.value);
  return Buffer.concat(parts);
}

const field = (entries, name) => {
  const e = entries.find((x) => x.name === name);
  return e ? e.value : undefined;
};
const normIp = (ip) => String(ip || '').trim().toLowerCase().replace(/:25565$/, '');

// Сервер проекта — первым в списке; свои серверы игрока остаются как были.
// Возвращает true, если файл изменён.
async function ensureServerListed(gameDir, { name, host, port }) {
  const file = path.join(gameDir, 'servers.dat');
  const ip = port && port !== 25565 ? `${host}:${port}` : host;
  let root = { name: '', value: [] };
  let existing = null;
  try {
    existing = await fsp.readFile(file);
  } catch {
    /* файла ещё нет — создадим */
  }
  if (existing) root = readNbt(existing); // испорченный файл не перезаписываем: пусть вызывающий решит

  let list = root.value.find((e) => e.name === 'servers' && e.type === T.LIST);
  if (!list) {
    list = { name: 'servers', type: T.LIST, value: { itemType: T.COMPOUND, items: [] } };
    root.value.push(list);
  }
  if (list.value.items.length && list.value.itemType !== T.COMPOUND) throw new Error('servers.dat: неожиданный формат списка');
  const items = list.value.items;

  const first = items[0];
  if (first && normIp(field(first, 'ip')) === normIp(ip) && field(first, 'name') === name) return false;

  // Иконку сервера из старой записи сохраняем, чтобы не мигала пустая.
  const old = items.find((it) => normIp(field(it, 'ip')) === normIp(ip));
  const icon = old && old.find((x) => x.name === 'icon' && x.type === T.STRING);
  const entry = [
    { name: 'name', type: T.STRING, value: name },
    { name: 'ip', type: T.STRING, value: ip },
  ];
  if (icon) entry.push(icon);
  list.value = { itemType: T.COMPOUND, items: [entry, ...items.filter((it) => normIp(field(it, 'ip')) !== normIp(ip))] };

  await fsp.mkdir(gameDir, { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, writeNbt(root));
  await fsp.rename(tmp, file);
  return true;
}

module.exports = { readNbt, writeNbt, ensureServerListed, T };
