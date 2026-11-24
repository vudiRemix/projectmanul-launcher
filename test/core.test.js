'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const { safeJoin, createPaths } = require('../src/core/paths');
const { rulesAllow, mavenPath, libraryKey } = require('../src/core/rules');
const { offlineUuid, collectArgs, mergeVersions, splitArgs } = require('../src/core/launch');
const { verifySignature, validateManifest, getManifest } = require('../src/core/manifest');
const { writeVarInt, readVarInt } = require('../src/core/server');
const { planBuildFiles, cleanManagedDirs, filterOnce } = require('../src/core/modpack');
const { Progress, syncFiles } = require('../src/core/tasks');
const { cleanRemote } = require('../src/core/remote');
const { compareVersions } = require('../src/core/updater');
const { globToRegex } = require('../tools/publish');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'milsim-test-'));

test('safeJoin не выпускает за папку игры', () => {
  const base = path.resolve(tmp());
  assert.strictEqual(safeJoin(base, 'mods/a.jar'), path.join(base, 'mods', 'a.jar'));
  for (const bad of ['../x', 'mods/../../x', '/etc/x', 'C:/x', 'mods\\x', 'mods//x', './x', '']) {
    assert.throws(() => safeJoin(base, bad), `должен отклонить ${bad}`);
  }
});

test('правила Mojang для ОС и флагов', () => {
  assert.strictEqual(rulesAllow(undefined), true);
  assert.strictEqual(rulesAllow([{ action: 'allow', os: { name: 'windows' } }]), process.platform === 'win32');
  assert.strictEqual(rulesAllow([{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }]), process.platform !== 'darwin');
  assert.strictEqual(rulesAllow([{ action: 'allow', features: { is_demo_user: true } }], {}), false);
  assert.strictEqual(rulesAllow([{ action: 'allow', features: { has_custom_resolution: true } }], { has_custom_resolution: true }), true);
});

test('пути Maven', () => {
  assert.strictEqual(mavenPath('org.lwjgl:lwjgl:3.3.1'), 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar');
  assert.strictEqual(mavenPath('org.lwjgl:lwjgl:3.3.1:natives-windows'), 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar');
  assert.strictEqual(mavenPath('de.oceanlabs.mcp:mcp_config:1.20.1@zip'), 'de/oceanlabs/mcp/mcp_config/1.20.1/mcp_config-1.20.1.zip');
  assert.strictEqual(libraryKey('a.b:c:1.0:natives-windows'), 'a.b:c:natives-windows');
});

test('офлайн-UUID совпадает с Java UUID.nameUUIDFromBytes', () => {
  // Эталон посчитан через java.util.UUID.nameUUIDFromBytes("OfflinePlayer:<ник>")
  const expected = process.env.UUID_NOTCH || 'b50ad385829d3141a2167e7d7539ba7f';
  assert.strictEqual(offlineUuid('Notch'), expected);
});

test('аргументы запуска с правилами и подстановками', () => {
  const list = [
    '--username',
    '${auth_player_name}',
    { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '${resolution_width}'] },
    { rules: [{ action: 'allow', features: { is_quick_play_multiplayer: true } }], value: '--quickPlayMultiplayer' },
    { rules: [{ action: 'allow', features: { is_demo_user: true } }], value: '--demo' },
  ];
  const out = collectArgs(list, { has_custom_resolution: true }, { auth_player_name: 'Soldier_42', resolution_width: 1920 });
  assert.deepStrictEqual(out, ['--username', 'Soldier_42', '--width', '1920']);
  assert.deepStrictEqual(splitArgs('-XX:+UseG1GC  "-Dfoo=a b" -Dx=1'), ['-XX:+UseG1GC', '-Dfoo=a b', '-Dx=1']);
});

test('слияние версий: библиотеки Forge в приоритете, без дублей', () => {
  const vanilla = { id: '1.20.1', mainClass: 'net.minecraft.client.main.Main', libraries: [{ name: 'a:b:1' }, { name: 'c:d:1' }], arguments: { game: ['g1'], jvm: ['j1'] }, assetIndex: { id: '5' } };
  const forge = { id: '1.20.1-forge-47.3.0', mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher', libraries: [{ name: 'a:b:2' }], arguments: { game: ['g2'], jvm: ['j2'] } };
  const m = mergeVersions(vanilla, forge);
  assert.deepStrictEqual(m.libraries.map((l) => l.name), ['a:b:2', 'c:d:1']);
  assert.deepStrictEqual(m.arguments.game, ['g1', 'g2']);
  assert.strictEqual(m.mainClass, 'cpw.mods.bootstraplauncher.BootstrapLauncher');
});

test('VarInt туда-обратно', () => {
  for (const n of [0, 1, 127, 128, 255, 25565, 763, 2097151]) {
    const [v, off] = readVarInt(writeVarInt(n), 0);
    assert.strictEqual(v, n);
    assert.strictEqual(off, writeVarInt(n).length);
  }
});

test('glob из конфига публикации', () => {
  assert.ok(globToRegex('config/**/*-client.toml').test('config/tacz-client.toml'));
  assert.ok(globToRegex('config/**/*-client.toml').test('config/a/b/x-client.toml'));
  assert.ok(!globToRegex('config/**/*-client.toml').test('config/x-common.toml'));
  assert.ok(globToRegex('**/*.bak').test('mods/a.bak'));
  assert.ok(globToRegex('options.txt').test('options.txt'));
});

test('remote config чистится от мусора', () => {
  const r = cleanRemote({ server: { host: 'evil host; rm', port: 99999 }, nickCheckUrl: 'javascript:alert(1)' });
  assert.deepStrictEqual(r.server, { host: 'localhost', port: 25565 });
  assert.strictEqual(r.nickCheckUrl, '');
  assert.strictEqual(cleanRemote({ nickCheckUrl: 'http://1.2.3.4:8765/nick/{nick}' }).nickCheckUrl, 'http://1.2.3.4:8765/nick/{nick}');
});

test('сравнение версий лаунчера', () => {
  assert.strictEqual(compareVersions('1.0.1', '1.0.0'), 1);
  assert.strictEqual(compareVersions('1.0.0', '1.0.0'), 0);
  assert.strictEqual(compareVersions('1.2', '1.10'), -1);
});

test('манифест: подпись и проверка структуры', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const body = Buffer.from(JSON.stringify({ format: 1, version: '1', minecraft: '1.20.1', forge: '47.3.0', files: [] }));
  const sig = crypto.sign(null, body, privateKey).toString('base64');
  assert.ok(verifySignature(body, sig, pub));
  assert.ok(!verifySignature(Buffer.concat([body, Buffer.from(' ')]), sig, pub));
  assert.ok(!verifySignature(body, 'AAAA', pub));
  assert.throws(() => validateManifest({ format: 1, version: '1', minecraft: '1.20.1', forge: '47', files: [{ path: 'a', sha256: 'x', size: 1, url: 'https://a' }] }));
  assert.throws(() => validateManifest({ format: 1, version: '1', minecraft: '1.20.1', forge: '47', files: [{ path: 'a', sha256: 'a'.repeat(64), size: 1, url: 'http://insecure' }] }));
  const m = validateManifest({ format: 1, version: '1', minecraft: '1.20.1', forge: '47', cleanDirs: ['mods', 'shaderpacks', '../x'], files: [] });
  assert.deepStrictEqual(m.cleanDirs, ['mods']);
});

test('полный цикл: публикация локально → установка → чистка лишнего', async () => {
  const work = tmp();
  const src = path.join(work, 'src');
  fs.mkdirSync(path.join(src, 'mods'), { recursive: true });
  fs.mkdirSync(path.join(src, 'config'), { recursive: true });
  fs.writeFileSync(path.join(src, 'mods', 'tacz-test.jar'), crypto.randomBytes(200000));
  fs.writeFileSync(path.join(src, 'config', 'tacz-client.toml'), 'a=1\n');
  fs.writeFileSync(path.join(src, 'config', 'server.toml'), 'b=2\n');
  fs.writeFileSync(path.join(src, 'options.txt'), 'lang:ru_ru\n');
  const keyFile = path.join(work, 'key.pem');
  const pub = execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'keygen.js'), keyFile], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .pop()
    .trim();
  const cfgFile = path.join(work, 'publish.config.json');
  fs.writeFileSync(
    cfgFile,
    JSON.stringify({ source: src, include: ['mods', 'config', 'options.txt'], once: ['options.txt', 'config/**/*-client.toml'], minecraft: '1.20.1', forge: '47.3.0', privateKey: keyFile }),
  );
  const out = path.join(work, 'release');
  execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'publish.js'), '--config', cfgFile, '--local', out, '--version', 't1'], { encoding: 'utf8' });

  const game = path.join(work, 'game');
  const paths = createPaths(game);
  const config = { manifestUrl: pathToFileURL(path.join(out, 'manifest.json')).href, publicKey: pub };
  const { manifest } = await getManifest(config, paths);
  assert.strictEqual(manifest.version, 't1');
  assert.strictEqual(manifest.files.find((f) => f.path === 'options.txt').mode, 'once');

  const progress = new Progress(() => {});
  await syncFiles(filterOnce(planBuildFiles(paths, manifest)), { stage: 'build', progress, full: true });
  assert.ok(fs.existsSync(path.join(game, 'mods', 'tacz-test.jar')));

  // Игрок портит мод, добавляет свой мод и шейдер, меняет клиентский конфиг.
  fs.writeFileSync(path.join(game, 'mods', 'tacz-test.jar'), 'hacked');
  fs.writeFileSync(path.join(game, 'mods', 'xray.jar'), 'cheat');
  fs.mkdirSync(path.join(game, 'shaderpacks'), { recursive: true });
  fs.writeFileSync(path.join(game, 'shaderpacks', 'bsl.zip'), 'shader');
  fs.writeFileSync(path.join(game, 'config', 'tacz-client.toml'), 'a=999\n');

  const res = await syncFiles(filterOnce(planBuildFiles(paths, manifest)), { stage: 'build', progress, full: true });
  assert.strictEqual(res.downloaded, 1, 'восстановлен только испорченный мод');
  const removed = await cleanManagedDirs(paths, manifest);
  assert.deepStrictEqual(removed, ['mods/xray.jar']);
  assert.notStrictEqual(fs.readFileSync(path.join(game, 'mods', 'tacz-test.jar'), 'utf8'), 'hacked');
  assert.ok(fs.existsSync(path.join(game, 'shaderpacks', 'bsl.zip')), 'шейдеры не трогаем');
  assert.strictEqual(fs.readFileSync(path.join(game, 'config', 'tacz-client.toml'), 'utf8'), 'a=999\n', 'клиентский конфиг игрока сохранён');

  // Подделанный манифест не принимается.
  const tampered = fs.readFileSync(path.join(out, 'manifest.json'), 'utf8').replace('"t1"', '"t2"');
  fs.writeFileSync(path.join(out, 'manifest.json'), tampered);
  await assert.rejects(getManifest(config, createPaths(path.join(work, 'game2'))), /Подпись/);
});
