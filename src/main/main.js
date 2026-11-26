'use strict';
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const { loadLauncherConfig } = require('../core/config');
const { SettingsStore, systemMemory } = require('../core/settings');
const { Logger } = require('../core/logger');
const { GameManager } = require('../core/game');
const { loadRemoteConfig, loadNews } = require('../core/remote');
const { pingServer, checkNick, NICK_RE } = require('../core/server');
const { getManifest } = require('../core/manifest');
const { needsUpdate, downloadAndRunUpdate } = require('../core/updater');

const APP_ROOT = path.join(__dirname, '..', '..');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start() {
  let config;
  let configError = null;
  try {
    config = loadLauncherConfig(APP_ROOT);
  } catch (err) {
    configError = err.message;
    config = { projectName: 'Launcher', projectId: 'launcher', configured: false, problems: [err.message] };
  }

  app.setName(config.projectName);
  // Для разработки: отдельный профиль, чтобы не трогать настройки настоящего лаунчера.
  if (process.env.MILSIM_USERDATA) app.setPath('userData', process.env.MILSIM_USERDATA);
  const userData = app.getPath('userData');
  const logger = new Logger(path.join(userData, 'logs', 'launcher.log'));
  const settings = new SettingsStore(path.join(userData, 'settings.json'));
  const defaultRoot = path.join(app.getPath('appData'), `.${config.projectId}`);
  const game = new GameManager({ config, settings, logger, defaultRoot, appVersion: app.getVersion() });
  let win = null;
  let remote = null;
  let lastCrash = null;

  logger.log(`Лаунчер ${app.getVersion()} запущен`);
  if (!config.configured) logger.log(`Лаунчер не настроен: ${config.problems.join('; ')}`);

  const send = (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  game.on('progress', (p) => send('game:progress', p));
  game.on('steps', (s) => send('game:steps', s));
  game.on('game-start', () => {
    send('game:state', { running: true });
    if (win) win.hide();
  });
  game.on('game-exit', (e) => {
    lastCrash = e.crash;
    if (win) {
      win.show();
      win.focus();
    }
    send('game:state', { running: false, code: e.code, crashed: e.code !== 0, crashFile: e.crash && e.crash.file });
  });
  logger.on('line', (line) => send('log:line', line));

  function createWindow(onShown) {
    win = new BrowserWindow({
      width: 1100,
      height: 660,
      resizable: false,
      maximizable: false,
      frame: false,
      show: false,
      backgroundColor: '#141414',
      title: config.projectName,
      icon: path.join(__dirname, '..', 'renderer', 'assets', 'logo.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    win.removeMenu();
    win.once('ready-to-show', () => {
      win.show();
      if (onShown) onShown();
    });
    // Только при npm start: Ctrl+R перезагружает интерфейс, F12 — инструменты разработчика.
    if (!app.isPackaged) {
      win.webContents.on('before-input-event', (e, input) => {
        if (input.type !== 'keyDown') return;
        if (input.control && input.key.toLowerCase() === 'r') win.webContents.reload();
        else if (input.key === 'F12') win.webContents.toggleDevTools({ mode: 'detach' });
      });
    }
    // Внешние ссылки (новости) открываем в браузере, навигацию внутри окна запрещаем.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    // Для разработки: снимок окна в PNG и выход (MILSIM_SCREENSHOT=путь.png).
    if (process.env.MILSIM_SCREENSHOT) {
      win.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          const img = await win.webContents.capturePage();
          require('fs').writeFileSync(process.env.MILSIM_SCREENSHOT, img.toPNG());
          app.quit();
        }, Number(process.env.MILSIM_SCREENSHOT_DELAY || 2500));
      });
    }
  }

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    projectName: config.projectName,
    locale: app.getLocale(),
    configured: config.configured,
    problems: config.problems,
    configError,
    memory: systemMemory(),
    defaultGameDir: defaultRoot,
  }));

  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', (_e, patch) => {
    if (game.busy || game.running) {
      // Папку игры нельзя менять, пока идёт загрузка или игра запущена.
      if (patch && 'gameDir' in patch) delete patch.gameDir;
    }
    return settings.update(patch || {});
  });

  ipcMain.handle('remote:load', async () => {
    const cacheDir = game.paths().internal;
    if (!config.configured) return { remote: null, news: { items: [] } };
    const [r, news] = await Promise.all([loadRemoteConfig(config, cacheDir), loadNews(config, cacheDir)]);
    remote = r;
    return { remote: r, news };
  });

  ipcMain.handle('server:status', async () => {
    if (!remote) return { online: false };
    try {
      return await pingServer(remote.server.host, remote.server.port);
    } catch {
      return { online: false };
    }
  });

  ipcMain.handle('nick:check', async (_e, nick) => {
    if (typeof nick !== 'string' || !NICK_RE.test(nick)) return { status: 'invalid' };
    return checkNick(remote && remote.nickCheckUrl, nick);
  });

  const asResult = async (fn) => {
    try {
      return { ok: true, ...(await fn()) };
    } catch (err) {
      const cancelled = err && err.message === 'Отменено';
      if (!cancelled) logger.error('операция не удалась', err);
      return { ok: false, cancelled, error: err ? err.message : String(err) };
    }
  };

  ipcMain.handle('game:play', () =>
    asResult(async () => {
      if (!config.configured) throw new Error('Лаунчер не настроен');
      const s = settings.get();
      if (!NICK_RE.test(s.nick)) throw new Error('Сначала введите ник');
      if (!remote) remote = await loadRemoteConfig(config, game.paths().internal);
      return game.play(remote);
    }),
  );
  ipcMain.handle('game:verify', () => asResult(() => game.verify()));
  ipcMain.handle('game:cancel', () => game.cancel());
  ipcMain.handle('game:state', () => ({ busy: game.busy, running: game.running }));

  ipcMain.handle('logs:get', () => logger.tail(500));
  ipcMain.handle('logs:copy', () => {
    clipboard.writeText(game.supportReport(lastCrash));
    return true;
  });
  ipcMain.handle('logs:open', () => shell.openPath(path.dirname(logger.file)));
  ipcMain.handle('dir:open', () => shell.openPath(game.paths().root));
  ipcMain.handle('dir:choose', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths[0]) return null;
    return settings.update({ gameDir: res.filePaths[0] });
  });

  ipcMain.handle('window:minimize', () => win && win.minimize());
  ipcMain.handle('window:close', () => {
    // Пока идёт загрузка — отменяем её, игру не трогаем.
    game.cancel();
    app.quit();
  });

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app.on('window-all-closed', () => {
    if (!game.running) app.quit();
  });

  // ---------- проверка обновлений до открытия лаунчера ----------

  function createSplash() {
    const splash = new BrowserWindow({
      width: 460,
      height: 236,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      frame: false,
      show: false,
      center: true,
      backgroundColor: '#141414',
      title: config.projectName,
      icon: path.join(__dirname, '..', 'renderer', 'assets', 'logo.png'),
      webPreferences: {
        preload: path.join(__dirname, 'splash-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    splash.removeMenu();
    splash.once('ready-to-show', () => splash.show());
    splash.webContents.on('will-navigate', (e) => e.preventDefault());
    splash.loadFile(path.join(__dirname, '..', 'renderer', 'splash.html'));
    return splash;
  }

  const SPLASH_TEXT = {
    ru: {
      sub: 'Лаунчер',
      checking: 'Проверяем обновления…',
      downloading: 'Скачиваем обновление {v}…',
      installing: 'Устанавливаем обновление…',
      upToDate: 'Последняя версия',
      mb: 'МБ',
    },
    en: {
      sub: 'Launcher',
      checking: 'Checking for updates…',
      downloading: 'Downloading update {v}…',
      installing: 'Installing the update…',
      upToDate: 'Up to date',
      mb: 'MB',
    },
  };

  // true — обновление скачано и запущено, лаунчер сейчас закроется.
  async function updateBeforeStart(splash) {
    const lang = settings.get().language || (app.getLocale().toLowerCase().startsWith('ru') ? 'ru' : 'en');
    const L = SPLASH_TEXT[lang];
    let last = {};
    const show = (state) => {
      last = { name: config.projectName.toUpperCase(), sub: `${L.sub} · v${app.getVersion()}`, ...state };
      if (!splash.isDestroyed()) splash.webContents.send('splash:state', last);
    };
    splash.webContents.on('did-finish-load', () => show(last));
    show({ text: L.checking });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let result;
    try {
      result = await getManifest(config, game.paths(), { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    // Без интернета (манифест из кэша) не обновляемся — просто открываем лаунчер.
    if (result.offline || !needsUpdate(result.manifest, app.getVersion())) {
      show({ text: L.upToDate, done: true, percent: 1 });
      return false;
    }

    const l = result.manifest.launcher;
    const mb = (n) => (n / 1048576).toFixed(1);
    logger.log(`Обновляю лаунчер до ${l.version}`);
    let got = 0;
    let sentAt = 0;
    const text = L.downloading.replace('{v}', l.version);
    show({ text, percent: 0, detail: `0.0 / ${mb(l.size)} ${L.mb}` });
    await downloadAndRunUpdate(result.manifest, app.getPath('temp'), {
      onProgress: (n) => {
        got = Math.max(0, got + n);
        if (Date.now() - sentAt < 100) return;
        sentAt = Date.now();
        show({ text, percent: Math.min(1, got / l.size), detail: `${mb(got)} / ${mb(l.size)} ${L.mb}` });
      },
    });
    show({ text: L.installing });
    setTimeout(() => app.quit(), 1500);
    return true;
  }

  async function launch() {
    // При npm start окно проверки не показываем (MILSIM_SPLASH=1 — показать для проверки).
    if (!config.configured || !(app.isPackaged || process.env.MILSIM_SPLASH)) return createWindow();
    const splash = createSplash();
    const shownAt = Date.now();
    if (process.env.MILSIM_SPLASH_SHOT) {
      splash.webContents.once('did-finish-load', () =>
        setTimeout(async () => {
          if (splash.isDestroyed()) return logger.log('снимок окна обновления: окно уже закрыто');
          try {
            require('fs').writeFileSync(process.env.MILSIM_SPLASH_SHOT, (await splash.webContents.capturePage()).toPNG());
          } catch (err) {
            logger.log(`снимок окна обновления не удался: ${err.message}`);
          }
        }, Number(process.env.MILSIM_SPLASH_SHOT_DELAY || 400)),
      );
    }
    try {
      if (await updateBeforeStart(splash)) return;
    } catch (err) {
      // Обновление не должно мешать играть: при любой ошибке открываем лаунчер как есть.
      logger.log(`Проверка обновлений лаунчера не удалась: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, Math.max(0, 900 - (Date.now() - shownAt))));
    createWindow(() => {
      if (!splash.isDestroyed()) splash.destroy();
    });
  }

  app.whenReady().then(launch);
}
