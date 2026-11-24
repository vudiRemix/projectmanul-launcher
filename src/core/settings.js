'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const GB = 1024 ** 3;

function systemMemory() {
  const totalGb = Math.round(os.totalmem() / GB);
  let recommended = 2;
  if (totalGb > 4) recommended = 4;
  if (totalGb > 8) recommended = 6;
  if (totalGb > 16) recommended = 8;
  const max = Math.max(2, totalGb - 2);
  return { totalGb, recommended: Math.min(recommended, max), min: 2, max };
}

const DEFAULTS = {
  nick: '',
  rememberNick: true,
  ramGb: null,
  jvmArgs: '',
  width: 1280,
  height: 720,
  fullscreen: false,
  language: null,
  gameDir: null,
};

function sanitize(input, mem) {
  const s = { ...DEFAULTS, ...input };
  s.nick = typeof s.nick === 'string' ? s.nick.slice(0, 16) : '';
  s.rememberNick = s.rememberNick !== false;
  const ram = Number(s.ramGb);
  s.ramGb = Number.isFinite(ram) ? Math.min(mem.max, Math.max(mem.min, Math.round(ram))) : mem.recommended;
  s.jvmArgs = typeof s.jvmArgs === 'string' ? s.jvmArgs.slice(0, 1000) : '';
  s.width = Math.min(7680, Math.max(640, Number(s.width) || 1280));
  s.height = Math.min(4320, Math.max(480, Number(s.height) || 720));
  s.fullscreen = Boolean(s.fullscreen);
  s.language = s.language === 'ru' || s.language === 'en' ? s.language : null;
  s.gameDir = typeof s.gameDir === 'string' && path.isAbsolute(s.gameDir) ? s.gameDir : null;
  return s;
}

class SettingsStore {
  constructor(file) {
    this.file = file;
    this.mem = systemMemory();
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      raw = {};
    }
    this.data = sanitize(raw, this.mem);
  }

  get() {
    return { ...this.data };
  }

  update(patch) {
    this.data = sanitize({ ...this.data, ...patch }, this.mem);
    const toSave = { ...this.data };
    if (!toSave.rememberNick) toSave.nick = '';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(toSave, null, 2));
    fs.renameSync(tmp, this.file);
    return this.get();
  }
}

module.exports = { SettingsStore, systemMemory, DEFAULTS };
