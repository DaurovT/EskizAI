# deploy — запуск и выкладка

| Файл | Что это |
| --- | --- |
| `docker/api.Dockerfile` | Образ API: FastAPI + `core` + `ai` (uv, Python 3.12-slim, пользователь без root). `RUN_MIGRATIONS=1` → `alembic upgrade head` перед стартом |
| `docker/web.Dockerfile` | Образ ссылки клиента: Next.js standalone, внутри собирается `viewer` |
| `docker/next.config.standalone.mjs` | Обёртка над `web/next.config.mjs` для Docker (standalone), исходник web не меняется |
| `docker-compose.yml` | Полный стек: Postgres 16, Redis 7, MinIO + создание бакета, api, worker (заготовка), web |
| `docker-compose.prod.yml` | Добавка для сервера: Caddy (HTTPS), без MinIO |
| `Caddyfile` | HTTPS и прокси: `API_DOMAIN` → api, `WEB_DOMAIN` → web |
| `.env.example` | Все переменные api/web/compose с пояснениями |
| `scripts/backup.sh`, `scripts/restore_check.sh` | Ежедневный дамп базы и проверка восстановления (NFR-12) |

Сборка всегда из корня репозитория (контекст `..`, исключения — `/.dockerignore`).

## Локально: весь стек

```bash
cp deploy/.env.example deploy/.env    # необязательно
make up                               # = docker compose -f deploy/docker-compose.yml up -d --build
```

- API: http://localhost:8000/docs, `GET /health`. Вход в dev — код `00000`.
- Ссылка клиента: http://localhost:3000/p/demo (демо-данные; `SHARE_API_URL` пустой).
- MinIO: http://localhost:9001 (логин/пароль — `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`), бакет `mebel` создаёт `minio-init`.
- Миграции применяет api при старте. Только миграции: `make migrate`.
- `make ps`, `make logs`, `make down` (тома остаются; `docker compose -f deploy/docker-compose.yml down -v` — удалить и данные).

Порты слушают только `127.0.0.1`. Сервис `worker` — заготовка под профилем `worker`: сейчас API выполняет задачи сам в фоновом потоке, поэтому api работает в один процесс (`--workers 1`).

## Сервер в ЕС (один VPS, Docker Compose + Caddy)

Пример — Hetzner Cloud, Ubuntu 24.04, CPX21 или больше (сборка `web` требует ~2 ГБ RAM), регион Falkenstein / Nuremberg / Helsinki. Условие хранения данных за рубежом (NFR-11) подтверждает юрист до пилота.

1. Файрвол провайдера: входящие только 22, 80, 443. Вход по SSH-ключу.
2. Docker Engine и плагин compose — по официальной инструкции docs.docker.com/engine/install/ubuntu.
3. DNS: A-записи `API_DOMAIN` и `WEB_DOMAIN` на IP сервера.
4. Код и настройки:
   ```bash
   sudo git clone <repo> /opt/mebel && cd /opt/mebel
   sudo cp deploy/.env.example deploy/.env && sudo chmod 600 deploy/.env
   sudo nano deploy/.env
   ```
   Обязательно поменять: `ENV=prod`, `POSTGRES_PASSWORD`, `JWT_SECRET` и `ADMIN_TOKEN` (`openssl rand -hex 32`), `AUTH_CODE_PROVIDER` (не `dev`), `API_DOMAIN`, `WEB_DOMAIN`, `ACME_EMAIL`, `CORS_ORIGINS=["https://<WEB_DOMAIN>"]`, `SHARE_BASE_URL=https://<WEB_DOMAIN>/p`, `ANTHROPIC_API_KEY`. API не стартует в prod с dev-секретами.
5. Запуск: `make prod-up` (= `docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build`). Caddy сам получит сертификаты.
6. Обновление: `git pull && make prod-up`. Миграции применятся при старте api.

Файлы: пока S3-хранилище в API — заглушка, поэтому в проде `STORAGE_BACKEND=local`, фото лежат в томе `media` и попадают в бэкап. Когда S3 появится — бакет в объектном хранилище в ЕС (Hetzner Object Storage и т. п.), переменные `S3_*`.

## Секреты

- Сервер: только `/opt/mebel/deploy/.env` (права 600, владелец root). В git — только `.env.example`.
- GitHub: CI секретов не требует (тесты ИИ идут на подставном клиенте). Для будущего деплоя из CI — GitHub Environments → secrets (SSH-ключ, `EXPO_TOKEN`).
- Приложение: секретов в нём нет и быть не должно. `EXPO_PUBLIC_*` попадают в сборку открытым текстом — туда только адреса.

## Бэкапы (NFR-12)

`backup.sh` делает `pg_dump -Fc` из контейнера postgres в `BACKUP_DIR` (по умолчанию `/var/backups/mebel`), проверяет, что архив читается, пишет `.sha256`, архивирует том `media` (при `STORAGE_BACKEND=local`), удаляет копии старше `BACKUP_KEEP_DAYS` и, если задан `BACKUP_RCLONE_TARGET`, копирует всё вне сервера через rclone (например, в бакет в другом регионе).

`restore_check.sh` разворачивает последний дамп во временную базу на том же Postgres, проверяет контрольную сумму, `pg_restore`, наличие таблиц и `alembic_version`, сверяет число строк с рабочей базой и удаляет временную базу. Код выхода ≠ 0 — бэкап негоден. `RESTORE_CHECK_PING_URL` — пинг мониторинга при успехе (healthchecks.io и т. п.).

```cron
# /etc/cron.d/mebel-backup — 03:15 по Ташкенту
15 22 * * * root /opt/mebel/deploy/scripts/backup.sh >> /var/log/mebel-backup.log 2>&1 && /opt/mebel/deploy/scripts/restore_check.sh >> /var/log/mebel-backup.log 2>&1
```

Восстановление вручную: `docker compose -f deploy/docker-compose.yml exec -T postgres pg_restore -U mebel -d mebel --clean --if-exists --no-owner < файл.dump` (при остановленных api и web).

## Приложение мастера: EAS

Сборки и обновления — Expo Application Services, в репозитории секретов нет.

1. Один раз в `app/`: `npx eas-cli login`, `npx eas-cli init` (пишет `projectId` в `app.json`). `eas.json` уже есть: профили `development`, `preview`, `production`, у каждого свой `environment` и `env.APP_VARIANT` (Expo SDK 58, Node ≥ 22.13).
2. Переменные — в EAS, а не в git: `npx eas-cli env:create --environment production --name EXPO_PUBLIC_API_URL --value https://<API_DOMAIN> --visibility plaintext` (также `EXPO_PUBLIC_SUPPORT_TG`). `EXPO_PUBLIC_DIAG=1` — только в development / preview, если нужна диагностика 3D. `APP_VARIANT` = `development` / `preview` разрешает в iOS обычный `http://` (ATS) и cleartext на Android — для API в локальной сети; `production` (и по умолчанию) — нет.
3. Ключи подписи Android/iOS хранит EAS (`eas credentials`), keystore и сертификаты в репозиторий не кладём.
4. Сборка: `npx eas-cli build --profile production --platform android`; обновления JS без магазина — `npx eas-cli update --channel production`.
5. Сборки из GitHub Actions — позже: секрет `EXPO_TOKEN` (токен робота Expo) в GitHub Environments.

## CI (`.github/workflows/ci.yml`)

По изменённым папкам: core, ai (pytest), api на SQLite и на Postgres 16 (`alembic upgrade head` + pytest с `TEST_DATABASE_URL`), viewer (typecheck, test, build), web (build, typecheck), app (`tsc --noEmit`, jest — если есть тесты), сборка обоих Docker-образов без публикации.

## Известные пробелы

- MinIO: официальные образы убраны из Docker Hub и Quay, закреплён `bitnamilegacy/minio` (обновлений нет). Только для локальной разработки.
- `SHARE_API_URL`: web берёт данные из `GET {SHARE_API_URL}/share/{token}` (формат `SharePayload`, `web/src/lib/share-types.ts`, совпадение с API проверено тестами). Пусто — демо-данные; в проде — `http://api:8000`.
- Sentry не подключён в коде (переменная `SENTRY_DSN` заведена заранее). Воркера на Redis нет.
- Образы собираются на сервере; публикация в реестр (GHCR) и деплой из CI — следующий шаг.
