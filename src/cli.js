'use strict';
// Консольный режим для проверки без окна:
//   node src/cli.js prepare --dir <папка> [--full] [--launch --nick Name]
//   node src/cli.js ping <host> [port]
//   node src/cli.js nick <url-с-{nick}> <ник>
const path = require('path');
const { loadLauncherConfig } = require('./core/config');
const { SettingsStore } = require('./core/settings');
const { Logger } = require('./core/logger');
const { GameManager } = require('./core/game');
const { pingServer, checkNick } = require('./core/server');
const { loadRemoteConfig } = require('./core/remote');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'ping') {
    console.log(await pingServer(process.argv[3], Number(process.argv[4] || 25565)));
    return;
  }
  if (cmd === 'nick') {
    console.log(await checkNick(process.argv[3], process.argv[4]));
    return;
  }
  if (cmd !== 'prepare') {
    console.log('Команды: prepare --dir <папка> [--full] [--launch --nick Name] | ping <host> [port] | nick <url> <ник>');
    process.exit(1);
  }
  const config = loadLauncherConfig(path.join(__dirname, '..'));
  if (!config.configured) console.warn(`Внимание: ${config.problems.join('; ')}`);
  const root = path.resolve(arg('dir', './game-test'));
  const settings = new SettingsStore(path.join(root, '.launcher', 'cli-settings.json'));
  if (arg('nick')) settings.update({ nick: arg('nick') });
  const logger = new Logger(path.join(root, '.launcher', 'cli.log'));
  logger.on('line', (l) => console.log(l));
  const game = new GameManager({ config, settings, logger, defaultRoot: root, appVersion: '0.0.0-cli' });
  let last = '';
  game.on('progress', (p) => {
    const line = `${p.stage} ${p.percent.toFixed(0)}% ${p.doneFiles}/${p.totalFiles}`;
    if (line !== last) process.stdout.write(`\r${line}          `);
    last = line;
  });
  game.on('steps', (s) => console.log(`\nшаги: ${JSON.stringify(s)}`));
  process.on('SIGINT', () => game.cancel());
  const started = Date.now();
  if (arg('launch')) {
    const remote = await loadRemoteConfig(config, path.join(root, '.launcher'));
    game.on('game-exit', (e) => {
      console.log('\nигра закрылась', e.code, e.crash && e.crash.file);
      process.exit(0);
    });
    await game.play(remote);
    console.log('\nигра запущена');
  } else {
    const res = arg('full') ? await game.verify() : await game.prepare({ signal: undefined });
    console.log(`\nготово за ${((Date.now() - started) / 1000).toFixed(1)} с, удалено лишних: ${res.removed.length}`);
  }
}

main().catch((err) => {
  console.error('\nОШИБКА:', err.stack || err.message);
  process.exit(1);
});
