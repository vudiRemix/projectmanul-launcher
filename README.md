# Project Manul — лаунчер

Electron-приложение под Windows: вход по нику, установка Java 17 + Minecraft 1.20.1 + Forge,
скачивание сборки по подписанному манифесту, проверка файлов перед каждым запуском, запуск с
автоподключением к серверу.

**Администратору сервера — пошаговая инструкция с нуля: [ИНСТРУКЦИЯ.md](ИНСТРУКЦИЯ.md).**

```
launcher.config.json      адреса манифеста, новостей и публичный ключ — вшивается в лаунчер
src/core/                 логика без интерфейса (работает и из консоли: src/cli.js)
src/main/                 главный процесс Electron
src/renderer/             интерфейс по макету
tools/keygen.js           создать ключ подписи
tools/publish.js          выпустить новую версию сборки на GitHub
release-repo/             config.json и news.json — лаунчер читает их прямо из этого репозитория
test/                     тесты: npm test
server/nickcheck-plugin/  плагин для Arclight: «ник занят?» через API AuthMe
server/modcheck-mod/      серверный Forge-мод: кик клиентов с лишними модами
```

## Настройка рабочего места

1. **Node.js 20+.** В папке репозитория: `npm install`, затем `node node_modules/electron/install.js`
   (npm 11 по умолчанию не запускает установочный скрипт Electron).
2. **Ключ подписи** уже создан: `keys/manifest-private.pem`. Он есть только на ПК администратора и в
   репозиторий не попадает (`.gitignore`). **Сделайте резервную копию** — без него нельзя выпустить сборку,
   которую примут уже установленные лаунчеры. Публичная половина записана в `launcher.config.json`.
3. **Токен GitHub** для публикации: Settings → Developer settings → Personal access tokens → Tokens (classic), галочка
   `public_repo` (fine-grained токен не подойдёт соавтору чужого репозитория).
4. **Название проекта:** `projectName` в `launcher.config.json`; `productName` в `package.json`.

## Выпуск сборки (раз в неделю)

1. Соберите клиент как обычно: папка с `mods/`, `config/`, `resourcepacks/` и т.д.
2. Один раз скопируйте `publish.config.example.json` → `publish.config.json` и укажите `repo`, `source`
   (папка клиента) и версию Forge.
3. Каждый выпуск:

```powershell
$env:GITHUB_TOKEN = "github_pat_..."
npm run release -- --notes "Обновили TACZ, добавили карту"
```

Скрипт загрузит только новые и изменённые файлы, подпишет манифест и опубликует релиз. Если что-то
сорвётся, черновик удаляется, и игроки ничего не получат. Проверить без загрузки: `--dry-run`.

Что значат поля конфига публикации:

| Поле | Смысл |
| --- | --- |
| `include` | какие папки/файлы клиента входят в сборку |
| `exclude` | что пропустить (маски `**/*.bak`) |
| `once` | файлы, которые лаунчер кладёт только если их нет, — игрок может менять их под себя (клиентские настройки) |
| `cleanDirs` | где лаунчер удаляет всё лишнее (по умолчанию только `mods`) |
| `launcher.installer` | путь к новому установщику лаунчера — тогда все лаунчеры обновятся сами |

## Сборка установщика лаунчера

```powershell
npm run dist
```

Готовый `dist/Project Manul Launcher Setup 1.0.0.exe` ставится без прав администратора. Для самообновления:
поднимите `version` в `package.json`, соберите, укажите путь в `publish.config.json` → `launcher.installer`
и выпустите сборку — лаунчеры игроков обновятся при следующем запуске.

Без сертификата подписи кода Windows SmartScreen покажет предупреждение при первой установке.

## Проверка без окна

```powershell
$env:MILSIM_CONFIG = "путь\к\dev.config.json"
node src/cli.js prepare --dir D:\test-game --nick Soldier_42
node src/cli.js prepare --dir D:\test-game --nick Soldier_42 --launch
node src/cli.js ping localhost 25565
```

`node tools/publish.js --config ... --local <папка>` собирает манифест с ссылками `file://` — так можно
проверить лаунчер вообще без GitHub.

## Где что лежит у игрока

- игра и сборка: `%APPDATA%\.projectmanul\` (меняется в настройках);
- настройки и логи лаунчера: `%APPDATA%\Project Manul Launcher\`.
