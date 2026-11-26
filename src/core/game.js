'use strict';
// Оркестратор: подготовка (Java → Minecraft и Forge → сборка → проверка) и запуск игры.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { createPaths } = require('./paths');
const { Progress, syncFiles } = require('./tasks');
const { getManifest } = require('./manifest');
const { planJava, fixPermissions } = require('./java');
const { loadVanillaVersion, planVanillaFiles, planAssets } = require('./minecraft');
const { ensureForge, planForgeLibraries } = require('./forge');
const { planBuildFiles, filterOnce, cleanManagedDirs } = require('./modpack');
const { buildLaunch } = require('./launch');
const { ensureServerListed } = require('./servers');

const STEPS = ['java', 'minecraft', 'build', 'verify', 'launch'];
const MAX_CMDLINE = 30000;

class GameManager extends EventEmitter {
  constructor({ config, settings, logger, defaultRoot, appVersion }) {
    super();
    this.config = config;
    this.settings = settings;
    this.logger = logger;
    this.defaultRoot = defaultRoot;
    this.appVersion = appVersion;
    this.busy = false;
    this.child = null;
    this.controller = null;
    this.lastManifest = null;
    this.steps = {};
  }

  paths() {
    return createPaths(this.settings.get().gameDir || this.defaultRoot);
  }

  log(msg) {
    this.logger.log(msg);
  }

  resetSteps() {
    this.steps = Object.fromEntries(STEPS.map((s) => [s, 'pending']));
    this.emit('steps', { ...this.steps });
  }

  step(name, status) {
    this.steps[name] = status;
    this.emit('steps', { ...this.steps });
  }

  get running() {
    return Boolean(this.child);
  }

  async prepare({ full = false, signal }) {
    const paths = this.paths();
    await fsp.mkdir(paths.temp, { recursive: true });
    const log = (m) => this.log(m);
    const progress = new Progress((p) => this.emit('progress', p));
    this.resetSteps();
    let current = 'java';
    try {
      this.step('java', 'active');
      const { manifest, offline } = await getManifest(this.config, paths, { signal });
      this.lastManifest = manifest;
      if (offline) log('GitHub недоступен — использую сохранённый манифест');
      log(`Сборка ${manifest.version}: Minecraft ${manifest.minecraft}, Forge ${manifest.forge}, файлов: ${manifest.files.length}`);
      const vanilla = await loadVanillaVersion(paths, manifest.minecraft, { signal });
      const component = (vanilla.javaVersion && vanilla.javaVersion.component) || 'java-runtime-gamma';
      const java = await planJava(paths, component, { signal });
      await syncFiles(java.files, { stage: 'java', progress, concurrency: 8, full, signal, log });
      await fixPermissions(java.files);
      this.step('java', 'done');

      current = 'minecraft';
      this.step('minecraft', 'active');
      await syncFiles(planVanillaFiles(paths, vanilla), { stage: 'minecraft', progress, concurrency: 8, full, signal, log });
      await syncFiles(await planAssets(paths, vanilla, { signal }), { stage: 'assets', progress, concurrency: 16, full, signal, log });
      progress.reset('forge', 0, 0);
      let forge = await ensureForge(paths, { mc: manifest.minecraft, forge: manifest.forge, javaExe: java.java, onLog: log, signal });
      if (full) {
        const res = await syncFiles(planForgeLibraries(paths, forge.json), { stage: 'forge', progress, concurrency: 8, full, signal, log });
        // Если библиотеки Forge были испорчены, пересобираем клиент установщиком.
        if (res.downloaded > 0) forge = await ensureForge(paths, { mc: manifest.minecraft, forge: manifest.forge, javaExe: java.java, onLog: log, signal, force: true });
      }
      this.step('minecraft', 'done');

      current = 'build';
      this.step('build', 'active');
      await syncFiles(filterOnce(planBuildFiles(paths, manifest)), { stage: 'build', progress, concurrency: 4, full: true, signal, log });
      this.step('build', 'done');

      current = 'verify';
      this.step('verify', 'active');
      const removed = await cleanManagedDirs(paths, manifest, log);
      this.step('verify', 'done');
      return { paths, manifest, vanilla, forgeJson: forge.json, java, removed };
    } catch (err) {
      this.step(current, 'error');
      throw err;
    }
  }

  async play(remote) {
    if (this.busy || this.child) throw new Error('Игра уже запускается или запущена');
    this.busy = true;
    this.controller = new AbortController();
    try {
      const settings = this.settings.get();
      const ctx = await this.prepare({ signal: this.controller.signal });
      this.step('launch', 'active');
      // Игра открывается в главном меню, а сервер проекта уже стоит первым в «Сетевой игре».
      // Сразу на сервер — только если в release-repo/config.json "autoConnect": true.
      if (remote && remote.server) {
        try {
          await ensureServerListed(ctx.paths.gameDir, { name: this.config.projectName, ...remote.server });
        } catch (err) {
          this.log(`Список серверов не обновлён: ${err.message}`);
        }
      }
      const cmd = await buildLaunch({
        paths: ctx.paths,
        vanilla: ctx.vanilla,
        forgeJson: ctx.forgeJson,
        java: ctx.java,
        settings,
        server: remote && remote.autoConnect ? remote.server : null,
        appVersion: this.appVersion,
        launcherName: `${this.config.projectId}-launcher`,
      });
      await this.startGame(cmd, ctx);
      this.step('launch', 'done');
      return { removed: ctx.removed, version: ctx.manifest.version };
    } finally {
      this.busy = false;
      this.controller = null;
    }
  }

  async verify() {
    if (this.busy || this.child) throw new Error('Сначала закройте игру');
    this.busy = true;
    this.controller = new AbortController();
    try {
      const ctx = await this.prepare({ full: true, signal: this.controller.signal });
      return { removed: ctx.removed, version: ctx.manifest.version };
    } finally {
      this.busy = false;
      this.controller = null;
    }
  }

  cancel() {
    if (this.controller) this.controller.abort(new Error('Отменено'));
  }

  async startGame(cmd, ctx) {
    let args = cmd.args;
    const length = cmd.executable.length + args.reduce((s, a) => s + a.length + 3, 0);
    if (process.platform === 'win32' && length > MAX_CMDLINE) {
      // Слишком длинная командная строка для Windows — передаём аргументы файлом (@argfile Java 9+).
      const argfile = path.join(ctx.paths.internal, 'launch-args.txt');
      const quote = (a) => `"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      await fsp.writeFile(argfile, args.map(quote).join('\n'));
      args = [`@${argfile}`];
    }
    const settings = this.settings.get();
    this.log(`Запуск ${cmd.versionId} для ${settings.nick}, память ${settings.ramGb} ГБ`);
    const started = Date.now();
    const child = spawn(cmd.executable, args, { cwd: cmd.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
    this.child = child;
    let pending = '';
    const onData = (buf) => {
      pending += buf.toString('utf8');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) if (line.trim()) this.logger.log(`[игра] ${line}`);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (err) => {
        this.child = null;
        reject(err);
      });
    });
    this.emit('game-start');
    child.on('close', async (code) => {
      this.child = null;
      if (pending.trim()) this.logger.log(`[игра] ${pending}`);
      this.log(`Игра закрылась, код ${code}`);
      const crash = code !== 0 ? await this.findCrash(ctx.paths, started) : null;
      this.emit('game-exit', { code, crash });
    });
  }

  async findCrash(paths, since) {
    try {
      const files = await fsp.readdir(paths.crashReports);
      let newest = null;
      for (const name of files) {
        const st = await fsp.stat(path.join(paths.crashReports, name));
        if (st.mtimeMs >= since - 1000 && (!newest || st.mtimeMs > newest.mtime)) newest = { name, mtime: st.mtimeMs };
      }
      if (!newest) return { file: null, text: '' };
      const text = await fsp.readFile(path.join(paths.crashReports, newest.name), 'utf8');
      return { file: newest.name, text: text.slice(0, 20000) };
    } catch {
      return { file: null, text: '' };
    }
  }

  supportReport(crash) {
    const s = this.settings.get();
    const lines = [
      `Лаунчер: ${this.appVersion}`,
      `Сборка: ${this.lastManifest ? this.lastManifest.version : 'не загружена'}`,
      `Система: ${os.type()} ${os.release()} ${os.arch()}, ОЗУ ${Math.round(os.totalmem() / 1024 ** 3)} ГБ`,
      `Ник: ${s.nick}, память игре: ${s.ramGb} ГБ, JVM: ${s.jvmArgs || '—'}, экран: ${s.fullscreen ? 'полный' : `${s.width}x${s.height}`}`,
      '',
      '--- Последние строки лога ---',
      ...this.logger.tail(250),
    ];
    if (crash && crash.text) lines.push('', `--- Краш-репорт ${crash.file} ---`, crash.text);
    return lines.join('\n');
  }
}

module.exports = { GameManager, STEPS };
