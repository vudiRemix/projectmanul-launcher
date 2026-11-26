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

  function createWindow() {
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
    win.once('ready-to-show', () => win.show());
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

  ipcMain.handle('update:check', async () =>
    asResult(async () => {
      if (!config.configured || !app.isPackaged) return { update: false };
      const { manifest } = await getManifest(config, game.paths());
      if (!needsUpdate(manifest, app.getVersion())) return { update: false };
      logger.log(`Обновляю лаунчер до ${manifest.launcher.version}`);
      send('update:progress', { version: manifest.launcher.version });
      await downloadAndRunUpdate(manifest, app.getPath('temp'));
      setTimeout(() => app.quit(), 500);
      return { update: true, version: manifest.launcher.version };
    }),
  );

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

  app.whenReady().then(createWindow);
}
