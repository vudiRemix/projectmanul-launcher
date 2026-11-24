# Серверная часть

Сервер: Arclight 1.20.1 (Forge + Bukkit), AuthMe на MySQL.

## NickCheck (плагин)

Отвечает лаунчеру, зарегистрирован ли ник в AuthMe: `GET /nick/<ник>` → `{"registered": true|false}`.
Работает через официальный API AuthMe, поэтому доступ к MySQL ему не нужен.

1. `server/nickcheck-plugin/build/libs/NickCheck-1.0.0.jar` (после сборки) → в папку `plugins/` сервера.
2. Запустите сервер, поправьте `plugins/NickCheck/config.yml` (порт по умолчанию 8765).
3. В `config.json` репозитория: `"nickCheckUrl": "http://<адрес-сервера>:8765/nick/{nick}"`.
4. Когда будете открывать сервер наружу — пробросьте и этот порт.

Пересборка: `cd nickcheck-plugin` → `gradlew build` (нужна Java 17+).

## ModCheck (серверный мод)

При входе сверяет список модов клиента с модами сервера. Лишние — кик с их списком.
Клиентам этот мод ставить не нужно.

1. `server/modcheck-mod/build/libs/modcheck-1.0.0.jar` (после сборки) → в папку `mods/` сервера.
2. После первого запуска откройте `config/modcheck-server.toml` и впишите в `allowedClientMods`
   id клиентских модов из сборки, которых нет на сервере (миникарта, Oculus и т.п.). Узнать id
   проще всего так: зайдите своим клиентом — в логе сервера будет строка
   `[ModCheck] <ник> кикнут, лишние моды: ...`.
3. `kickVanilla = true` не пускает клиентов без Forge.

Пересборка: `cd modcheck-mod` → `gradlew build` (Gradle сам скачает JDK 17 для сборки).
